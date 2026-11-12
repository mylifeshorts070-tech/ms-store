
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const {
  onDocumentUpdated
} = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue
} = require("firebase-admin/firestore");
const crypto = require("crypto");

initializeApp();

const db = getFirestore();
const REGION = "asia-south1";
const REWARD_AMOUNT = 50;
const MINIMUM_SUBTOTAL = 200;
const MINIMUM_WITHDRAWAL = 200;

function requireUser(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "প্রথমে Login করুন।");
  }
  return request.auth.uid;
}

function makeCode() {
  return "MS" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function cleanNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

/*
 * Create or load the user's referral profile.
 * A referral code can be registered only once.
 */
exports.registerReferral = onCall(
  { region: REGION },
  async (request) => {
    const uid = requireUser(request);
    const requestedCode = String(
      request.data?.referralCode || ""
    ).trim().toUpperCase();

    const profileRef = db.collection("referralProfiles").doc(uid);

    return db.runTransaction(async (tx) => {
      const profileSnap = await tx.get(profileRef);

      if (profileSnap.exists) {
        return {
          referralCode: profileSnap.data().referralCode,
          referred: Boolean(profileSnap.data().referredByUid)
        };
      }

      const customerRef = db.collection("customerProfiles").doc(uid);
      const customerSnap = await tx.get(customerRef);

      if (customerSnap.exists && customerSnap.data().banned) {
        throw new HttpsError("permission-denied", "এই অ্যাকাউন্টটি বন্ধ আছে।");
      }

      let referredByUid = null;

      if (requestedCode) {
        const codeRef = db.collection("referralCodes").doc(requestedCode);
        const codeSnap = await tx.get(codeRef);

        if (!codeSnap.exists) {
          throw new HttpsError("not-found", "Referral Code সঠিক নয়।");
        }

        referredByUid = codeSnap.data().uid;

        if (!referredByUid || referredByUid === uid) {
          throw new HttpsError(
            "failed-precondition",
            "নিজের Referral Code ব্যবহার করা যাবে না।"
          );
        }

        const referrerProfileRef =
          db.collection("customerProfiles").doc(referredByUid);

        const referrerSnap = await tx.get(referrerProfileRef);

        if (!referrerSnap.exists || referrerSnap.data().banned) {
          throw new HttpsError(
            "failed-precondition",
            "এই Referral Code ব্যবহার করা যাচ্ছে না।"
          );
        }
      }

      let newCode = makeCode();
      let codeRef = db.collection("referralCodes").doc(newCode);
      let codeSnap = await tx.get(codeRef);

      if (codeSnap.exists) {
        throw new HttpsError(
          "aborted",
          "Code তৈরি হয়নি। আবার চেষ্টা করুন।"
        );
      }

      tx.set(profileRef, {
        uid,
        referralCode: newCode,
        referredByUid,
        createdAt: FieldValue.serverTimestamp()
      });

      tx.set(codeRef, {
        uid,
        createdAt: FieldValue.serverTimestamp()
      });

      tx.set(db.collection("referralWallets").doc(uid), {
        uid,
        availableBalance: 0,
        pendingBalance: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      return {
        referralCode: newCode,
        referred: Boolean(referredByUid)
      };
    });
  }
);

/*
 * Dashboard data. Only the signed-in user's data is returned.
 */
exports.getReferralDashboard = onCall(
  { region: REGION },
  async (request) => {
    const uid = requireUser(request);

    const profileRef = db.collection("referralProfiles").doc(uid);
    const profileSnap = await profileRef.get();

    if (!profileSnap.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Referral Profile তৈরি হয়নি।"
      );
    }

    const walletSnap = await db
      .collection("referralWallets")
      .doc(uid)
      .get();

    const referralSnap = await db
      .collection("referrals")
      .where("referrerUid", "==", uid)
      .get();

    const withdrawalSnap = await db
      .collection("referralWithdrawals")
      .where("uid", "==", uid)
      .get();

    const referrals = referralSnap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id,
        name: x.customerName || "Customer",
        orderId: x.orderId || "",
        status: x.status || "Pending",
        date: x.createdAt?.toDate?.().toLocaleDateString("en-GB") || ""
      };
    });

    const withdrawals = withdrawalSnap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id,
        method: x.method,
        amount: Number(x.amount || 0),
        accountNumber: x.accountNumber,
        status: x.status || "Pending",
        date: x.createdAt?.toDate?.().toLocaleDateString("en-GB") || ""
      };
    });

    const wallet = walletSnap.exists ? walletSnap.data() : {};

    return {
      referralCode: profileSnap.data().referralCode,
      totalReferrals: referrals.length,
      successfulReferrals: referrals.filter(
        x => x.status === "Successful"
      ).length,
      pendingBalance: Number(wallet.pendingBalance || 0),
      availableBalance: Number(wallet.availableBalance || 0),
      referralHistory: referrals,
      withdrawalHistory: withdrawals
    };
  }
);

/*
 * Create a withdrawal request.
 * Balance is reserved immediately to prevent duplicate withdrawals.
 */
exports.requestReferralWithdrawal = onCall(
  { region: REGION },
  async (request) => {
    const uid = requireUser(request);

    const method = String(request.data?.method || "");
    const accountNumber = cleanNumber(request.data?.accountNumber);
    const amount = Number(request.data?.amount);

    if (!["bKash", "Nagad"].includes(method)) {
      throw new HttpsError("invalid-argument", "Payment Method সঠিক নয়।");
    }

    if (!/^01[3-9]\d{8}$/.test(accountNumber)) {
      throw new HttpsError("invalid-argument", "মোবাইল নম্বর সঠিক নয়।");
    }

    if (
      !Number.isInteger(amount) ||
      amount < MINIMUM_WITHDRAWAL
    ) {
      throw new HttpsError(
        "invalid-argument",
        "সর্বনিম্ন Withdrawal ৳২০০।"
      );
    }

    const walletRef = db.collection("referralWallets").doc(uid);
    const withdrawalRef = db.collection("referralWithdrawals").doc();

    await db.runTransaction(async (tx) => {
      const walletSnap = await tx.get(walletRef);

      if (!walletSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "Referral Wallet পাওয়া যায়নি।"
        );
      }

      const wallet = walletSnap.data();
      const available = Number(wallet.availableBalance || 0);

      if (available < amount) {
        throw new HttpsError(
          "failed-precondition",
          "আপনার Wallet-এ পর্যাপ্ত ব্যালেন্স নেই।"
        );
      }

      tx.update(walletRef, {
        availableBalance: available - amount,
        updatedAt: FieldValue.serverTimestamp()
      });

      tx.set(withdrawalRef, {
        uid,
        method,
        accountNumber,
        amount,
        status: "Pending",
        createdAt: FieldValue.serverTimestamp()
      });
    });

    return {
      success: true,
      requestId: withdrawalRef.id
    };
  }
);

/*
 * Reward only when an order changes to Delivered.
 * The product subtotal must be strictly greater than ৳200.
 * A referred customer can generate only one reward.
 */
exports.rewardReferralOnDelivered = onDocumentUpdated(
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

    if (Number(after.subtotal || 0) <= MINIMUM_SUBTOTAL) {
      return;
    }

    const referredUid = after.uid;
    if (!referredUid) return;

    const profileRef =
      db.collection("referralProfiles").doc(referredUid);

    const profileSnap = await profileRef.get();
    if (!profileSnap.exists) return;

    const referrerUid = profileSnap.data().referredByUid;
    if (!referrerUid || referrerUid === referredUid) return;

    const walletRef =
      db.collection("referralWallets").doc(referrerUid);

    const rewardRef =
      db.collection("referralRewards").doc(referredUid);

    const referralRef =
      db.collection("referrals").doc(referredUid);

    await db.runTransaction(async (tx) => {
      const rewardSnap = await tx.get(rewardRef);
      if (rewardSnap.exists) return;

      const walletSnap = await tx.get(walletRef);
      if (!walletSnap.exists) {
        throw new Error("Referral wallet missing");
      }

      const wallet = walletSnap.data();

      tx.update(walletRef, {
        availableBalance:
          Number(wallet.availableBalance || 0) + REWARD_AMOUNT,
        totalEarned:
          Number(wallet.totalEarned || 0) + REWARD_AMOUNT,
        updatedAt: FieldValue.serverTimestamp()
      });

      tx.set(rewardRef, {
        referrerUid,
        referredUid,
        orderId: event.params.orderId,
        subtotal: Number(after.subtotal),
        amount: REWARD_AMOUNT,
        status: "Credited",
        createdAt: FieldValue.serverTimestamp()
      });

      tx.set(referralRef, {
        referrerUid,
        referredUid,
        orderId: event.params.orderId,
        customerName: after.customerName || "Customer",
        status: "Successful",
        rewardAmount: REWARD_AMOUNT,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });
  }
);

/*
 * Create referral history when the referred customer places an order.
 */
exports.recordReferralOrder = onDocumentUpdated(
  {
    document: "orders/{orderId}",
    region: REGION
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (!before || !after) return;
    if (before.status || !after.status) return;

    const uid = after.uid;
    if (!uid) return;

    const profileSnap = await db
      .collection("referralProfiles")
      .doc(uid)
      .get();

    if (!profileSnap.exists) return;

    const referrerUid = profileSnap.data().referredByUid;
    if (!referrerUid) return;

    const referralRef = db.collection("referrals").doc(uid);
    const existing = await referralRef.get();

    if (existing.exists) return;

    await referralRef.set({
      referrerUid,
      referredUid: uid,
      orderId: event.params.orderId,
      customerName: after.customerName || "Customer",
      status: "Pending",
      rewardAmount: 0,
      createdAt: FieldValue.serverTimestamp()
    });
  }
);
