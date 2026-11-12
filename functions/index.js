// File: functions/index.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

const REGION = "asia-south1";
const ADMIN_UID = "WFvsYeqyZfgvnd8LVtCdT42gzjU2";

const DEFAULT_REWARD = 50;
const DEFAULT_MIN_PURCHASE = 200;
const DEFAULT_MIN_WITHDRAWAL = 200;
const DEFAULT_RETURN_DAYS = 7;

function requireCustomer(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Please log in first.");
  }

  if (request.auth.token.email_verified !== true) {
    throw new HttpsError(
      "permission-denied",
      "Please verify your email first."
    );
  }

  return request.auth.uid;
}

function requireAdmin(request) {
  if (!request.auth || request.auth.uid !== ADMIN_UID) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }

  return request.auth.uid;
}

function generateCode() {
  return "MS" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

async function getReferralSettings() {
  const snap = await db.doc("storeSettings/referralSettings").get();
  const data = snap.exists ? snap.data() : {};

  return {
    enabled: data.enabled === true,
    rewardAmount: Number(data.rewardAmount ?? DEFAULT_REWARD),
    minPurchase: Number(data.minPurchase ?? DEFAULT_MIN_PURCHASE),
    minWithdrawal: Number(
      data.minWithdrawal ?? DEFAULT_MIN_WITHDRAWAL
    ),
    returnDays: Number(data.returnDays ?? DEFAULT_RETURN_DAYS)
  };
}

function getWalletDefaults(data = {}) {
  return {
    pendingBalance: Number(data.pendingBalance || 0),
    availableBalance: Number(data.availableBalance || 0),
    reservedBalance: Number(data.reservedBalance || 0),
    totalEarned: Number(data.totalEarned || 0)
  };
}

// Create a unique referral code for the signed-in customer.
exports.createReferralProfile = onCall(
  { region: REGION },
  async (request) => {
    const uid = requireCustomer(request);
    const settings = await getReferralSettings();

    if (!settings.enabled) {
      throw new HttpsError(
        "failed-precondition",
        "The referral program is currently disabled."
      );
    }

    const profileRef = db.doc(`customerProfiles/${uid}`);

    return db.runTransaction(async (tx) => {
      const profileSnap = await tx.get(profileRef);

      if (!profileSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "Customer profile not found."
        );
      }

      const profile = profileSnap.data();

      if (profile.referralCode) {
        return { referralCode: profile.referralCode };
      }

      let code = "";
      let codeRef = null;
      let codeSnap = null;

      for (let i = 0; i < 10; i++) {
        code = generateCode();
        codeRef = db.doc(`referralCodes/${code}`);
        codeSnap = await tx.get(codeRef);

        if (!codeSnap.exists) break;

        code = "";
      }

      if (!code) {
        throw new HttpsError(
          "internal",
          "Could not generate a unique referral code. Please try again."
        );
      }

      tx.create(codeRef, {
        uid,
        createdAt: FieldValue.serverTimestamp()
      });

      tx.update(profileRef, {
        referralCode: code,
        referralCodeCreatedAt: FieldValue.serverTimestamp()
      });

      return { referralCode: code };
    });
  }
);

// Attach a referral code to a newly registered customer.
// Call this immediately after creating the customer's profile.
exports.registerReferral = onCall(
  { region: REGION },
  async (request) => {
    const uid = requireCustomer(request);
    const code = String(request.data?.referralCode || "")
      .trim()
      .toUpperCase();

    if (!code) {
      return { success: true, referred: false };
    }

    if (!/^[A-Z0-9]{6,20}$/.test(code)) {
      throw new HttpsError("invalid-argument", "Invalid referral code.");
    }

    const settings = await getReferralSettings();

    if (!settings.enabled) {
      throw new HttpsError(
        "failed-precondition",
        "The referral program is currently disabled."
      );
    }

    const profileRef = db.doc(`customerProfiles/${uid}`);
    const codeRef = db.doc(`referralCodes/${code}`);

    return db.runTransaction(async (tx) => {
      const profileSnap = await tx.get(profileRef);
      const codeSnap = await tx.get(codeRef);

      if (!profileSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "Customer profile not found."
        );
      }

      if (!codeSnap.exists) {
        throw new HttpsError("not-found", "Referral code not found.");
      }

      const profile = profileSnap.data();
      const referrerUid = codeSnap.data().uid;

      if (profile.referrerUid) {
        throw new HttpsError(
          "already-exists",
          "A referral code has already been applied."
        );
      }

      if (referrerUid === uid) {
        throw new HttpsError(
          "invalid-argument",
          "You cannot use your own referral code."
        );
      }

      const createdAt = profile.createdAt;

      if (
        !createdAt ||
        typeof createdAt.toMillis !== "function" ||
        Date.now() - createdAt.toMillis() > 24 * 60 * 60 * 1000 ||
        createdAt.toMillis() > Date.now() + 5 * 60 * 1000
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Referral codes can only be applied within 24 hours of registration."
        );
      }

      const referrerRef = db.doc(`customerProfiles/${referrerUid}`);
      const referrerSnap = await tx.get(referrerRef);

      if (!referrerSnap.exists) {
        throw new HttpsError("not-found", "Referrer account not found.");
      }

      const existingOrders = await tx.get(
        db.collection("orders").where("uid", "==", uid).limit(1)
      );

      if (!existingOrders.empty) {
        throw new HttpsError(
          "failed-precondition",
          "A referral code cannot be applied after placing an order."
        );
      }

      tx.update(profileRef, {
        referrerUid,
        referralCodeUsed: code,
        referralRegisteredAt: FieldValue.serverTimestamp()
      });

      return { success: true, referred: true };
    });
  }
);

// Create one pending reward when a referred customer's qualifying order
// first changes to Delivered.
exports.createReferralRewardOnDelivery = onDocumentUpdated(
  {
    document: "orders/{orderId}",
    region: REGION
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (!before || !after) return;

    if (before.status === "Delivered" || after.status !== "Delivered") {
      return;
    }

    const referredUid = after.uid;

    if (!referredUid) return;

    const settings = await getReferralSettings();

    if (!settings.enabled) return;

    // Product subtotal is used; delivery charges are not counted.
    const purchaseAmount = Number(
      after.subtotal ?? after.totalPrice ?? after.total ?? 0
    );

    if (
      !Number.isFinite(purchaseAmount) ||
      purchaseAmount <= settings.minPurchase
    ) {
      return;
    }

    const orderId = event.params.orderId;
    const profileRef = db.doc(`customerProfiles/${referredUid}`);
    const rewardRef = db.doc(`referralRewards/${referredUid}`);

    await db.runTransaction(async (tx) => {
      const profileSnap = await tx.get(profileRef);

      if (!profileSnap.exists) return;

      const profile = profileSnap.data();
      const referrerUid = profile.referrerUid;

      if (!referrerUid || referrerUid === referredUid) return;

      const rewardSnap = await tx.get(rewardRef);

      // One reward maximum for each referred customer.
      if (rewardSnap.exists) return;

      const walletRef = db.doc(`referralWallets/${referrerUid}`);
      const walletSnap = await tx.get(walletRef);
      const wallet = getWalletDefaults(
        walletSnap.exists ? walletSnap.data() : {}
      );

      const eligibleAt = Timestamp.fromMillis(
        Date.now() + settings.returnDays * 24 * 60 * 60 * 1000
      );

      tx.create(rewardRef, {
        referrerUid,
        referredUid,
        orderId,
        purchaseAmount,
        rewardAmount: settings.rewardAmount,
        status: "pending",
        createdAt: FieldValue.serverTimestamp(),
        eligibleAt
      });

      tx.set(
        walletRef,
        {
          pendingBalance: wallet.pendingBalance + settings.rewardAmount,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });
  }
);

// Release pending rewards after the return period.
// The order is checked again before any money is moved.
exports.releaseReferralRewards = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "Asia/Dhaka",
    region: REGION
  },
  async () => {
    const now = Timestamp.now();

    const dueRewards = await db
      .collection("referralRewards")
      .where("status", "==", "pending")
      .where("eligibleAt", "<=", now)
      .limit(100)
      .get();

    for (const rewardDoc of dueRewards.docs) {
      const rewardRef = rewardDoc.ref;

      await db.runTransaction(async (tx) => {
        const freshRewardSnap = await tx.get(rewardRef);

        if (!freshRewardSnap.exists) return;

        const reward = freshRewardSnap.data();

        if (reward.status !== "pending") return;

        const orderRef = db.doc(`orders/${reward.orderId}`);
        const walletRef = db.doc(
          `referralWallets/${reward.referrerUid}`
        );

        const orderSnap = await tx.get(orderRef);
        const walletSnap = await tx.get(walletRef);

        const wallet = getWalletDefaults(
          walletSnap.exists ? walletSnap.data() : {}
        );

        const amount = Number(reward.rewardAmount || 0);
        const order = orderSnap.exists ? orderSnap.data() : {};

        const orderStillEligible =
          orderSnap.exists &&
          order.status === "Delivered" &&
          !["Returned", "Refunded", "Cancelled"].includes(
            String(order.returnStatus || "")
          ) &&
          !["Returned", "Refunded", "Cancelled"].includes(
            String(order.refundStatus || "")
          );

        if (!orderStillEligible) {
          tx.update(rewardRef, {
            status: "cancelled",
            cancelledAt: FieldValue.serverTimestamp(),
            cancelReason: "Order is no longer eligible."
          });

          tx.set(
            walletRef,
            {
              pendingBalance: Math.max(
                0,
                wallet.pendingBalance - amount
              ),
              updatedAt: FieldValue.serverTimestamp()
            },
            { merge: true }
          );

          return;
        }

        tx.update(rewardRef, {
          status: "available",
          releasedAt: FieldValue.serverTimestamp()
        });

        tx.set(
          walletRef,
          {
            pendingBalance: Math.max(
              0,
              wallet.pendingBalance - amount
            ),
            availableBalance: wallet.availableBalance + amount,
            totalEarned: wallet.totalEarned + amount,
            updatedAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      });
    }
  }
);

// Customer requests a withdrawal.
// Money is moved from available to reserved immediately.
exports.requestReferralWithdrawal = onCall(
  { region: REGION },
  async (request) => {
    const uid = requireCustomer(request);
    const settings = await getReferralSettings();

    if (!settings.enabled) {
      throw new HttpsError(
        "failed-precondition",
        "The referral program is currently disabled."
      );
    }

    const amount = Number(request.data?.amount);
    const method = String(request.data?.method || "").trim();
    const accountNumber = String(
      request.data?.accountNumber || ""
    ).replace(/\s+/g, "");

    if (
      !Number.isInteger(amount) ||
      amount < settings.minWithdrawal
    ) {
      throw new HttpsError(
        "invalid-argument",
        `Minimum withdrawal is ৳${settings.minWithdrawal}.`
      );
    }

    if (!["bKash", "Nagad"].includes(method)) {
      throw new HttpsError(
        "invalid-argument",
        "Choose bKash or Nagad."
      );
    }

    if (!/^01[0-9]{9}$/.test(accountNumber)) {
      throw new HttpsError(
        "invalid-argument",
        "Enter a valid 11-digit Bangladesh mobile number."
      );
    }

    const walletRef = db.doc(`referralWallets/${uid}`);
    const withdrawalRef = db.collection("referralWithdrawals").doc();

    await db.runTransaction(async (tx) => {
      const walletSnap = await tx.get(walletRef);
      const wallet = getWalletDefaults(
        walletSnap.exists ? walletSnap.data() : {}
      );

      if (wallet.availableBalance < amount) {
        throw new HttpsError(
          "failed-precondition",
          "Insufficient withdrawable balance."
        );
      }

      tx.set(
        walletRef,
        {
          availableBalance: wallet.availableBalance - amount,
          reservedBalance: wallet.reservedBalance + amount,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      tx.create(withdrawalRef, {
        uid,
        amount,
        method,
        accountNumber,
        status: "Pending",
        createdAt: FieldValue.serverTimestamp()
      });
    });

    return {
      success: true,
      withdrawalId: withdrawalRef.id
    };
  }
);

// Admin approves a pending withdrawal.
exports.approveReferralWithdrawal = onCall(
  { region: REGION },
  async (request) => {
    requireAdmin(request);

    const withdrawalId = String(
      request.data?.withdrawalId || ""
    ).trim();

    if (!withdrawalId) {
      throw new HttpsError("invalid-argument", "Withdrawal ID required.");
    }

    const ref = db.doc(`referralWithdrawals/${withdrawalId}`);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);

      if (!snap.exists) {
        throw new HttpsError("not-found", "Withdrawal not found.");
      }

      if (snap.data().status !== "Pending") {
        throw new HttpsError(
          "failed-precondition",
          "Only Pending withdrawals can be approved."
        );
      }

      tx.update(ref, {
        status: "Approved",
        approvedAt: FieldValue.serverTimestamp(),
        approvedBy: ADMIN_UID
      });
    });

    return { success: true };
  }
);

// Admin rejects a pending or approved withdrawal and releases the reserve.
exports.rejectReferralWithdrawal = onCall(
  { region: REGION },
  async (request) => {
    requireAdmin(request);

    const withdrawalId = String(
      request.data?.withdrawalId || ""
    ).trim();

    const reason = String(request.data?.reason || "")
      .trim()
      .slice(0, 300);

    if (!withdrawalId) {
      throw new HttpsError("invalid-argument", "Withdrawal ID required.");
    }

    const withdrawalRef = db.doc(
      `referralWithdrawals/${withdrawalId}`
    );

    await db.runTransaction(async (tx) => {
      const withdrawalSnap = await tx.get(withdrawalRef);

      if (!withdrawalSnap.exists) {
        throw new HttpsError("not-found", "Withdrawal not found.");
      }

      const withdrawal = withdrawalSnap.data();

      if (!["Pending", "Approved"].includes(withdrawal.status)) {
        throw new HttpsError(
          "failed-precondition",
          "This withdrawal cannot be rejected."
        );
      }

      const walletRef = db.doc(
        `referralWallets/${withdrawal.uid}`
      );

      const walletSnap = await tx.get(walletRef);
      const wallet = getWalletDefaults(
        walletSnap.exists ? walletSnap.data() : {}
      );

      const amount = Number(withdrawal.amount || 0);

      tx.set(
        walletRef,
        {
          reservedBalance: Math.max(
            0,
            wallet.reservedBalance - amount
          ),
          availableBalance: wallet.availableBalance + amount,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      tx.update(withdrawalRef, {
        status: "Rejected",
        rejectionReason: reason,
        rejectedAt: FieldValue.serverTimestamp(),
        rejectedBy: ADMIN_UID
      });
    });

    return { success: true };
  }
);

// Admin marks an approved withdrawal as paid after making the payout.
exports.markReferralWithdrawalPaid = onCall(
  { region: REGION },
  async (request) => {
    requireAdmin(request);

    const withdrawalId = String(
      request.data?.withdrawalId || ""
    ).trim();

    if (!withdrawalId) {
      throw new HttpsError("invalid-argument", "Withdrawal ID required.");
    }

    const withdrawalRef = db.doc(
      `referralWithdrawals/${withdrawalId}`
    );

    await db.runTransaction(async (tx) => {
      const withdrawalSnap = await tx.get(withdrawalRef);

      if (!withdrawalSnap.exists) {
        throw new HttpsError("not-found", "Withdrawal not found.");
      }

      const withdrawal = withdrawalSnap.data();

      if (withdrawal.status !== "Approved") {
        throw new HttpsError(
          "failed-precondition",
          "Only Approved withdrawals can be marked Paid."
        );
      }

      const walletRef = db.doc(
        `referralWallets/${withdrawal.uid}`
      );

      const walletSnap = await tx.get(walletRef);
      const wallet = getWalletDefaults(
        walletSnap.exists ? walletSnap.data() : {}
      );

      const amount = Number(withdrawal.amount || 0);

      if (wallet.reservedBalance < amount) {
        throw new HttpsError(
          "failed-precondition",
          "Reserved wallet balance is insufficient."
        );
      }

      tx.set(
        walletRef,
        {
          reservedBalance: wallet.reservedBalance - amount,
          updatedAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      tx.update(withdrawalRef, {
        status: "Paid",
        paidAt: FieldValue.serverTimestamp(),
        paidBy: ADMIN_UID
      });
    });

    return { success: true };
  }
);

// Admin updates referral program settings.
exports.updateReferralSettings = onCall(
  { region: REGION },
  async (request) => {
    requireAdmin(request);

    const data = request.data || {};

    const enabled = data.enabled === true;
    const rewardAmount = Number(data.rewardAmount);
    const minPurchase = Number(data.minPurchase);
    const minWithdrawal = Number(data.minWithdrawal);
    const returnDays = Number(data.returnDays);

    if (
      !Number.isFinite(rewardAmount) ||
      rewardAmount < 1 ||
      rewardAmount > 10000 ||
      !Number.isFinite(minPurchase) ||
      minPurchase < 0 ||
      minPurchase > 10000000 ||
      !Number.isFinite(minWithdrawal) ||
      minWithdrawal < 1 ||
      minWithdrawal > 10000000 ||
      !Number.isInteger(returnDays) ||
      returnDays < 1 ||
      returnDays > 60
    ) {
      throw new HttpsError(
        "invalid-argument",
        "One or more referral settings are invalid."
      );
    }

    await db.doc("storeSettings/referralSettings").set(
      {
        enabled,
        rewardAmount,
        minPurchase,
        minWithdrawal,
        returnDays,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: ADMIN_UID
      },
      { merge: true }
    );

    return { success: true };
  }
);
