const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.database();

// ==========================================
// ១. បង្កើត Order ដោយសុវត្ថិភាព (Server-side)
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
  if (!customerName || !phone) {
    throw new functions.https.HttpsError("invalid-argument", "ខ្វះព័ត៌មាន");
  }

  let subtotal = 0;
  const validatedItems = [];

  for (const item of items) {
    const productSnap = await db.ref("products/" + item.id).once("value");
    if (!productSnap.exists()) {
      throw new functions.https.HttpsError("not-found", `ផលិតផល ${item.id} រកមិនឃើញ`);
    }
    const product = productSnap.val();

    if ((product.stock || 0) < item.qty) {
      throw new functions.https.HttpsError("failed-precondition", `ស្តុក ${product.name} មិនគ្រប់គ្រាន់`);
    }

    subtotal += product.price * item.qty;

    validatedItems.push({
      id: item.id,
      name: product.name,
      price: product.price,
      qty: item.qty,
      image: product.image || ""
    });
  }

  const shippingFee = deliveryType === "pickup" ? 0 : 2.00;

  let discountAmount = 0;
  if (discountCode) {
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
  }

  const total = Math.max(0, subtotal + shippingFee - discountAmount);

  const orderRef = db.ref("orders").push();
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
// ២. បញ្ជាក់ការទូទាត់
// ==========================================
exports.confirmPayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "សូម Login");
  }

  const { orderId, paymentId } = data;
  if (!orderId || !paymentId) {
    throw new functions.https.HttpsError("invalid-argument", "ខ្វះព័ត៌មាន");
  }

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
});

// ==========================================
// ៣. Admin: បន្ថែម/កែ Balance អ្នកប្រើ
// ==========================================
exports.updateBalance = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "សូម Login");
  }

  const adminSnap = await db.ref("admins/" + context.auth.uid).once("value");
  if (adminSnap.val() !== true) {
    throw new functions.https.HttpsError("permission-denied", "មិនមែន Admin");
  }

  const { uid, amount, mode } = data;
  if (!uid || typeof amount !== "number" || amount < 0) {
    throw new functions.https.HttpsError("invalid-argument", "ព័ត៌មានមិនត្រឹមត្រូវ");
  }

  const userRef = db.ref("users/" + uid + "/balance");

  if (mode === "add") {
    await userRef.transaction((current) => (current || 0) + amount);
  } else {
    await userRef.set(amount);
  }

  return { success: true };
});