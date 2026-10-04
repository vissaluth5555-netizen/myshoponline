const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.database();

// ==========================================
// Helper: ត្រួតពិនិត្យ Admin
// ==========================================
async function isAdmin(uid) {
  const snap = await db.ref("admins/" + uid).once("value");
  return snap.val() === true;
}

// ==========================================
// Helper: កត់ត្រា Audit Log
// ==========================================
async function logAudit(action, adminUid, targetUid, details) {
  try {
    await db.ref("auditLogs").push({
      action: action,
      adminUid: adminUid,
      targetUid: targetUid || null,
      details: details || {},
      timestamp: admin.database.ServerValue.TIMESTAMP
    });
  } catch (err) {
    console.error("Audit log error:", err);
  }
}

// ==========================================
// ១. បង្កើត Order ដោយសុវត្ថិភាព
// ==========================================
exports.createOrder = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "សូម Login ជាមុន");
  }

  const uid = context.auth.uid;
  const { items, customerName, phone, deliveryType, street, city, notes, lat, lng, discountCode } = data;

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new functions.https.HttpsError("invalid-argument", "គ្មានទំនិញ");
  }
  if (items.length > 100) {
    throw new functions.https.HttpsError("invalid-argument", "ទំនិញច្រើនពេក");
  }
  if (!customerName || !phone) {
    throw new functions.https.HttpsError("invalid-argument", "ខ្វះព័ត៌មាន");
  }
  if (customerName.length > 100 || phone.length > 20) {
    throw new functions.https.HttpsError("invalid-argument", "ព័ត៌មានវែងពេក");
  }

  let subtotal = 0;
  const validatedItems = [];

  try {
    for (const item of items) {
      if (!item.id || typeof item.id !== "string") {
        throw new functions.https.HttpsError("invalid-argument", "Item ID មិនត្រឹមត្រូវ");
      }
      const qty = parseInt(item.qty) || 0;
      if (qty <= 0 || qty > 100) {
        throw new functions.https.HttpsError("invalid-argument", "ចំនួនទំនិញមិនត្រឹមត្រូវ");
      }

      const productSnap = await db.ref("products/" + item.id).once("value");
      if (!productSnap.exists()) {
        throw new functions.https.HttpsError("not-found", `ផលិតផល ${item.id} រកមិនឃើញ`);
      }
      const product = productSnap.val();

      if ((product.stock || 0) < qty) {
        throw new functions.https.HttpsError("failed-precondition", `ស្តុក ${product.name} មិនគ្រប់គ្រាន់`);
      }

      subtotal += product.price * qty;

      validatedItems.push({
        id: item.id,
        name: product.name,
        price: product.price,
        qty: qty,
        image: product.image || ""
      });
    }
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    console.error("Error validating items:", err);
    throw new functions.https.HttpsError("internal", "មានបញ្ហាក្នុងការពិនិត្យទំនិញ");
  }

  const shippingFee = deliveryType === "pickup" ? 0 : 2.00;

  let discountAmount = 0;
  if (discountCode) {
    try {
      const codeSnap = await db.ref("discountCodes").orderByChild("code").equalTo(discountCode.toUpperCase()).once("value");
      if (codeSnap.exists()) {
        const codes = codeSnap.val();
        const codeKey = Object.keys(codes)[0];
        const code = codes[codeKey];
        if (code.active !== false) {
          if (code.type === "percent") {
            discountAmount = (subtotal * code.value) / 100;
          } else {
            discountAmount = parseFloat(code.value) || 0;
          }
          discountAmount = Math.min(discountAmount, subtotal);
        }
      }
    } catch (err) {
      console.error("Error checking discount code:", err);
    }
  }

  const total = Math.max(0, subtotal + shippingFee - discountAmount);

  const orderRef = db.ref("orders").push();
  try {
    await orderRef.set({
      uid: uid,
      items: validatedItems,
      subtotal: subtotal,
      shippingFee: shippingFee,
      discount: discountAmount,
      total: total,
      status: "pending",
      paymentId: null,
      customerName: customerName,
      phone: phone,
      deliveryType: deliveryType || "home",
      street: street || "",
      city: city || "",
      notes: notes || "",
      lat: lat || null,
      lng: lng || null,
      createdAt: admin.database.ServerValue.TIMESTAMP
    });
  } catch (err) {
    console.error("Error saving order:", err);
    throw new functions.https.HttpsError("internal", "មិនអាចរក្សាទុក Order បានទេ");
  }

  return {
    success: true,
    orderId: orderRef.key,
    total: total,
    subtotal: subtotal,
    shippingFee: shippingFee,
    discount: discountAmount
  };
});

// ==========================================
// ២. បញ្ជាក់ការទូទាត់ (មាន Verification)
// ==========================================
exports.confirmPayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "សូម Login");
  }

  const { orderId, paymentId } = data;
  if (!orderId || !paymentId) {
    throw new functions.https.HttpsError("invalid-argument", "ខ្វះព័ត៌មាន");
  }

  try {
    const orderSnap = await db.ref("orders/" + orderId).once("value");
    if (!orderSnap.exists()) {
      throw new functions.https.HttpsError("not-found", "Order រកមិនឃើញ");
    }

    const order = orderSnap.val();
    if (order.uid !== context.auth.uid) {
      throw new functions.https.HttpsError("permission-denied", "មិនមែន Order របស់អ្នក");
    }
    if (order.status === "paid") {
      return { success: true, message: "បានបង់រួចហើយ" };
    }

    // ⭐ ផ្ទៀងផ្ទាត់ជាមួយ Cloudflare Worker
    const workerUrl = "https://wild-flower-04c0.ing88138.workers.dev";
    const verifyRes = await fetch(`${workerUrl}/check-status?id=${encodeURIComponent(paymentId)}`);
    if (!verifyRes.ok) {
      throw new functions.https.HttpsError("internal", "មិនអាចផ្ទៀងផ្ទាត់ការទូទាត់បានទេ");
    }
    const verifyData = await verifyRes.json();
    if (verifyData.status !== "paid" && verifyData.status !== "approved") {
      throw new functions.https.HttpsError("failed-precondition", "ការទូទាត់មិនទាន់ជោគជ័យ");
    }

    await db.ref().transaction(async (root) => {
      const orderData = root.orders?.[orderId];
      if (!orderData || orderData.status === "paid") return root;

      for (const item of orderData.items) {
        const product = root.products?.[item.id];
        if (product) {
          product.stock = Math.max(0, (product.stock || 0) - item.qty);
        }
      }

      orderData.status = "paid";
      orderData.paymentId = paymentId;
      orderData.paidAt = Date.now();

      return root;
    });

    return { success: true, message: "ការទូទាត់ជោគជ័យ" };
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    console.error("Error confirming payment:", err);
    throw new functions.https.HttpsError("internal", "មានបញ្ហាក្នុងការបញ្ជាក់ការទូទាត់");
  }
});

// ==========================================
// ៣. Admin: បន្ថែម/កែ Balance
// ==========================================
exports.updateBalance = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "សូម Login");
  }

  try {
    if (!(await isAdmin(context.auth.uid))) {
      throw new functions.https.HttpsError("permission-denied", "មិនមែន Admin");
    }

    const { uid, amount, mode } = data;

    const MAX_BALANCE = 1000000;
    const MIN_BALANCE = 0;

    if (!uid || typeof amount !== "number" || amount < 0 || amount > MAX_BALANCE) {
      throw new functions.https.HttpsError("invalid-argument", "ចំនួនមិនត្រឹមត្រូវ");
    }

    const userRef = db.ref("users/" + uid + "/balance");

    if (mode === "add") {
      await userRef.transaction((current) => {
        const newBalance = (current || 0) + amount;
        return Math.min(newBalance, MAX_BALANCE);
      });
    } else {
      if (amount < MIN_BALANCE) {
        throw new functions.https.HttpsError("invalid-argument", "Balance មិនអាចអវិជ្ជមាន");
      }
      await userRef.set(Math.min(amount, MAX_BALANCE));
    }

    // ⭐ Audit Log
    await logAudit("updateBalance", context.auth.uid, uid, { amount, mode });

    return { success: true };
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    console.error("Error updating balance:", err);
    throw new functions.https.HttpsError("internal", "មានបញ្ហាក្នុងការកែ Balance");
  }
});

// ==========================================
// ៤. Admin: លុប User ចេញពី Auth
// ==========================================
exports.deleteUserAuth = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "សូម Login");
  }

  try {
    if (!(await isAdmin(context.auth.uid))) {
      throw new functions.https.HttpsError("permission-denied", "មិនមែន Admin");
    }

    const { uid } = data;
    if (!uid) {
      throw new functions.https.HttpsError("invalid-argument", "ខ្វះ UID");
    }

    // ⭐ ការពារការលុប Admin ខ្លួនឯង
    if (uid === context.auth.uid) {
      throw new functions.https.HttpsError("invalid-argument", "មិនអាចលុបខ្លួនឯង");
    }

    // ⭐ ការពារការលុប Admin ផ្សេងទៀត
    if (await isAdmin(uid)) {
      throw new functions.https.HttpsError("permission-denied", "មិនអាចលុប Admin ផ្សេងទៀត");
    }

    await admin.auth().deleteUser(uid);
    await db.ref("users/" + uid).remove();

    // ⭐ Audit Log
    await logAudit("deleteUser", context.auth.uid, uid, {});

    return { success: true, message: "លុប User ជោគជ័យ" };
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    console.error("Error deleting user:", err);
    throw new functions.https.HttpsError("internal", "មានបញ្ហាក្នុងការលុប User");
  }
});