const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const DEFAULT_REWARD = 50;
const DEFAULT_MIN_PURCHASE = 200;
const DEFAULT_MIN_WITHDRAWAL = 200;
const DEFAULT_RETURN_DAYS = 7;

function requireCustomer(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Login required.");
  }

  if (request.auth.token.email_verified !== true) {
    throw new HttpsError("permission-denied", "Verify your email first.");
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
    minWithdrawal: Number(data.minWithdrawal ?? DEFAULT_MIN_WITHDRAWAL),
    returnDays: Number(data.returnDays ?? DEFAULT_RETURN_DAYS)
  };
}

// Create a unique referral code for a customer.
exports.createReferralProfile = onCall(async (request) => {
  const uid = requireCustomer(request);
  const profileRef = db.doc(`customerProfiles/${uid}`);

  return db.runTransaction(async (tx) => {
    const profileSnap = await tx.get(profileRef);

    if (!profileSnap.exists) {
      throw new HttpsError("failed-precondition", "Customer profile not found.");
    }

    const profile = profileSnap.data();

    if (profile.referralCode) {
      return { referralCode: profile.referralCode };
    }

    const settings = await getReferralSettings();

    if (!settings.enabled) {
      throw new HttpsError("failed-precondition", "Referral program is disabled.");
    }

    let code;
    let codeRef;
    let codeSnap;
    let attempts = 0;

    do {
      code = generateCode();
      codeRef = db.doc(`referralCodes/${code}`);
      codeSnap = await tx.get(codeRef);
      attempts++;
    } while (codeSnap.exists && attempts < 5);

    if (codeSnap.exists) {
      throw new HttpsError("aborted", "Please try again.");
    }

    tx.set(codeRef, {
      uid,
      createdAt: FieldValue.serverTimestamp()
    });

    tx.update(profileRef, {
      referralCode: code,
      referralCreatedAt: FieldValue.serverTimestamp()
    });

    return { referralCode: code };
  });
});

// Record the referral when a new customer account is created.
// The caller cannot choose an arbitrary referrer after signup.
exports.registerReferral = onCall(async (request) => {
  const uid = requireCustomer(request);
  const code = String(request.data?.referralCode || "").trim().toUpperCase();

  if (!code) {
    return { referred: false };
  }

  const settings = await getReferralSettings();

  if (!settings.enabled) {
    return { referred: false, reason: "disabled" };
  }

  const profileRef = db.doc(`customerProfiles/${uid}`);
  const codeRef = db.doc(`referralCodes/${code}`);

  return db.runTransaction(async (tx) => {
    const [profileSnap, codeSnap] = await Promise.all([
      tx.get(profileRef),
      tx.get(codeRef)
    ]);

    if (!profileSnap.exists || !codeSnap.exists) {
      return { referred: false, reason: "invalid_code" };
    }

    const profile = profileSnap.data();
    const referrerUid = codeSnap.data().uid;

    if (profile.referrerUid) {
      return { referred: false, reason: "already_referred" };
    }

    if (referrerUid === uid) {
      return { referred: false, reason: "self_referral" };
    }

    const referrerSnap = await tx.get(db.doc(`customerProfiles/${referrerUid}`));

    if (!referrerSnap.exists || referrerSnap.data().banned === true) {
      return { referred: false, reason: "invalid_referrer" };
    }

    tx.update(profileRef, {
      referrerUid,
      referralCodeUsed: code,
      referralJoinedAt: FieldValue.serverTimestamp()
    });

    const referralId = uid;
    tx.create(db.doc(`referrals/${referralId}`), {
      referrerUid,
      referredUid: uid,
      referralCode: code,
      status: "registered",
      createdAt: FieldValue.serverTimestamp()
    });

    return { referred: true };
  });
});

// Withdrawal requests are stored separately.
// Wallet balances are not changed by the customer request.
exports.requestReferralWithdrawal = onCall(async (request) => {
  const uid = requireCustomer(request);
  const amount = Number(request.data?.amount);
  const method = String(request.data?.method || "");
  const accountNumber = String(request.data?.accountNumber || "").trim();

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new HttpsError("invalid-argument", "Invalid withdrawal amount.");
  }

  if (!["bKash", "Nagad"].includes(method)) {
    throw new HttpsError("invalid-argument", "Choose bKash or Nagad.");
  }

  if (!/^[0-9]{11}$/.test(accountNumber)) {
    throw new HttpsError("invalid-argument", "Enter a valid 11-digit number.");
  }

  const settings = await getReferralSettings();
  const profileRef = db.doc(`customerProfiles/${uid}`);
  const requestRef = db.collection("referralWithdrawals").doc();

  await db.runTransaction(async (tx) => {
    const profileSnap = await tx.get(profileRef);

    if (!profileSnap.exists || profileSnap.data().banned === true) {
      throw new HttpsError("permission-denied", "Account unavailable.");
    }

    const wallet = Number(profileSnap.data().referralWallet || 0);
    const reserved = Number(profileSnap.data().referralReserved || 0);
    const available = wallet - reserved;

    if (amount < settings.minWithdrawal) {
      throw new HttpsError(
        "failed-precondition",
        `Minimum withdrawal is ৳${settings.minWithdrawal}.`
      );
    }

    if (amount > available) {
      throw new HttpsError("failed-precondition", "Insufficient available balance.");
    }

    tx.update(profileRef, {
      referralReserved: reserved + amount
    });

    tx.create(requestRef, {
      uid,
      amount,
      method,
      accountNumber,
      status: "Pending",
      createdAt: FieldValue.serverTimestamp()
    });
  });

  return { success: true, requestId: requestRef.id };
});

// Release the reserved amount if an admin rejects a withdrawal.
exports.rejectReferralWithdrawal = onCall(async (request) => {
  if (!request.auth || request.auth.token.email_verified !== true) {
    throw new HttpsError("unauthenticated", "Admin login required.");
  }

  const adminUid = request.auth.uid;
  if (adminUid !== "WFvsYeqyZfgvnd8LVtCdT42gzjU2") {
    throw new HttpsError("permission-denied", "Admin only.");
  }

  const requestId = String(request.data?.requestId || "");
  if (!requestId) {
    throw new HttpsError("invalid-argument", "Request ID required.");
  }

  const withdrawalRef = db.doc(`referralWithdrawals/${requestId}`);

  await db.runTransaction(async (tx) => {
    const withdrawalSnap = await tx.get(withdrawalRef);

    if (!withdrawalSnap.exists || withdrawalSnap.data().status !== "Pending") {
      throw new HttpsError("failed-precondition", "Request is not pending.");
    }

    const withdrawal = withdrawalSnap.data();
    const profileRef = db.doc(`customerProfiles/${withdrawal.uid}`);
    const profileSnap = await tx.get(profileRef);

    if (!profileSnap.exists) {
      throw new HttpsError("not-found", "Customer not found.");
    }

    const reserved = Number(profileSnap.data().referralReserved || 0);

    tx.update(profileRef, {
      referralReserved: Math.max(0, reserved - withdrawal.amount)
    });

    tx.update(withdrawalRef, {
      status: "Rejected",
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: adminUid
    });
  });

  return { success: true };
});

// Admin marks a withdrawal as paid only after manually sending the money.
exports.markReferralWithdrawalPaid = onCall(async (request) => {
  if (!request.auth || request.auth.token.email_verified !== true ||
      request.auth.uid !== "WFvsYeqyZfgvnd8LVtCdT42gzjU2") {
    throw new HttpsError("permission-denied", "Admin only.");
  }

  const requestId = String(request.data?.requestId || "");
  if (!requestId) {
    throw new HttpsError("invalid-argument", "Request ID required.");
  }

  const withdrawalRef = db.doc(`referralWithdrawals/${requestId}`);

  await db.runTransaction(async (tx) => {
    const withdrawalSnap = await tx.get(withdrawalRef);

    if (!withdrawalSnap.exists || withdrawalSnap.data().status !== "Pending") {
      throw new HttpsError("failed-precondition", "Request is not pending.");
    }

    const withdrawal = withdrawalSnap.data();
    const profileRef = db.doc(`customerProfiles/${withdrawal.uid}`);
    const profileSnap = await tx.get(profileRef);

    if (!profileSnap.exists) {
      throw new HttpsError("not-found", "Customer not found.");
    }

    const profile = profileSnap.data();
    const reserved = Number(profile.referralReserved || 0);
    const wallet = Number(profile.referralWallet || 0);

    if (reserved < withdrawal.amount || wallet < withdrawal.amount) {
      throw new HttpsError("failed-precondition", "Wallet reservation mismatch.");
    }

    tx.update(profileRef, {
      referralWallet: wallet - withdrawal.amount,
      referralReserved: reserved - withdrawal.amount
    });

    tx.update(withdrawalRef, {
      status: "Paid",
      paidAt: FieldValue.serverTimestamp(),
      reviewedBy: request.auth.uid
    });
  });

  return { success: true };
});

// Credit a referral reward only after an admin marks the order Delivered
// and the configured return period has passed.
// This function is intentionally not triggered by client-side order creation.
exports.checkReferralReward = onDocumentUpdated(
  {
    document: "orders/{orderId}",
    region: "asia-south1"
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (!before || !after || after.status !== "Delivered" ||
        before.status === "Delivered") {
      return;
    }

    const uid = after.uid;
    const orderId = event.params.orderId;
    const total = Number(after.subtotal ?? after.totalPrice ?? 0);

    if (!uid || total <= DEFAULT_MIN_PURCHASE) {
      return;
    }

    const settings = await getReferralSettings();

    if (!settings.enabled || total <= settings.minPurchase) {
      return;
    }

    const profileRef = db.doc(`customerProfiles/${uid}`);
    const referralRef = db.doc(`referrals/${uid}`);
    const rewardRef = db.doc(`referralRewards/${orderId}`);

    await db.runTransaction(async (tx) => {
      const [profileSnap, referralSnap, rewardSnap] = await Promise.all([
        tx.get(profileRef),
        tx.get(referralRef),
        tx.get(rewardRef)
      ]);

      if (!profileSnap.exists || !referralSnap.exists || rewardSnap.exists) {
        return;
      }

      const referral = referralSnap.data();

      if (referral.status === "rewarded" || referral.status === "rejected") {
        return;
      }

      const referrerUid = referral.referrerUid;
      if (!referrerUid || referrerUid === uid) return;

      const referrerRef = db.doc(`customerProfiles/${referrerUid}`);
      const referrerSnap = await tx.get(referrerRef);

      if (!referrerSnap.exists || referrerSnap.data().banned === true) {
        return;
      }

      const wallet = Number(referrerSnap.data().referralWallet || 0);

      tx.create(rewardRef, {
        orderId,
        referredUid: uid,
        referrerUid,
        amount: settings.rewardAmount,
        status: "PendingReturnPeriod",
        deliveredAt: FieldValue.serverTimestamp(),
        eligibleAt: admin.firestore.Timestamp.fromMillis(
          Date.now() + settings.returnDays * 24 * 60 * 60 * 1000
        )
      });

      tx.update(referralRef, {
        status: "delivered",
        qualifyingOrderId: orderId
      });

      tx.update(referrerRef, {
        referralPending: FieldValue.increment(settings.rewardAmount)
      });
    });
  }
);

// Scheduled task to credit rewards after the return period.
// A reward is credited once, using a transaction and a stable reward document ID.
const { onSchedule } = require("firebase-functions/v2/scheduler");

exports.creditMatureReferralRewards = onSchedule(
  {
    schedule: "every 24 hours",
    timeZone: "Asia/Dhaka",
    region: "asia-south1"
  },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const rewards = await db.collection("referralRewards")
      .where("status", "==", "PendingReturnPeriod")
      .where("eligibleAt", "<=", now)
      .limit(300)
      .get();

    for (const rewardDoc of rewards.docs) {
      await db.runTransaction(async (tx) => {
        const freshReward = await tx.get(rewardDoc.ref);
        if (!freshReward.exists ||
            freshReward.data().status !== "PendingReturnPeriod") {
          return;
        }

        const reward = freshReward.data();
        const referrerRef = db.doc(`customerProfiles/${reward.referrerUid}`);
        const referralRef = db.doc(`referrals/${reward.referredUid}`);
        const referrerSnap = await tx.get(referrerRef);

        if (!referrerSnap.exists || referrerSnap.data().banned === true) {
          tx.update(freshReward.ref, { status: "Rejected" });
          return;
        }

        const wallet = Number(referrerSnap.data().referralWallet || 0);
        const pending = Number(referrerSnap.data().referralPending || 0);

        tx.update(referrerRef, {
          referralWallet: wallet + reward.amount,
          referralPending: Math.max(0, pending - reward.amount)
        });

        tx.update(freshReward.ref, {
          status: "Credited",
          creditedAt: FieldValue.serverTimestamp()
        });

        tx.update(referralRef, {
          status: "rewarded",
          rewardedAt: FieldValue.serverTimestamp()
        });
      });
    }
  }
);
