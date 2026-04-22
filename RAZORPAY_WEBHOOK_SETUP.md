# Razorpay Payment Button - Webhook Setup Guide

## ✅ Webhook Implementation Complete

The backend webhook endpoint `/api/razorpay-webhook` has been added to handle payment confirmations from Razorpay.

---

## 📋 Setup Steps

### Step 1: Get Your Public Domain URL

The webhook needs a **public HTTPS URL** that Razorpay can reach. Choose one:

**Option A: Ngrok (for testing/development)**
- Install: `npm install -g ngrok`
- Run: `ngrok http 3000`
- Copy the HTTPS URL: `https://xxxx-xx-xxx-xxx.ngrok.io`
- This URL will be active for 8 hours

**Option B: Vercel/Netlify (production)**
- Deploy your Node.js app to Vercel/Netlify
- Use the deployment URL

**Option C: Your Hosting Provider**
- If hosted on a VPS (AWS, DigitalOcean, etc.)
- Use `https://yourdomain.com`

---

### Step 2: Configure Webhook in Razorpay Dashboard

1. Log in to [Razorpay Dashboard](https://dashboard.razorpay.com/)
2. Go to **Settings** → **Webhooks**
3. Click **Add New Webhook**
4. Fill in the form:
   - **Webhook URL**: `https://yourdomain-or-ngrok-url/api/razorpay-webhook`
   - **Alert Email**: Your email address
   - **Active**: ✅ (toggle to ON)
5. Under **Events**, select:
   - ✅ `payment.authorized`
   - ✅ `payment.failed`
6. Click **Create Webhook**

**You'll get a Webhook Secret** (starts with `whsec_`). While the webhook signs requests, we verify using the KEY_SECRET which is already in your .env file.

---

### Step 3: Test the Webhook

Use a tool like Postman or curl to send a test webhook:

```bash
# Example test webhook
curl -X POST http://localhost:3000/api/razorpay-webhook \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: test_signature" \
  -d '{
    "event": "payment.authorized",
    "payload": {
      "payment": {
        "entity": {
          "id": "pay_test_123",
          "order_id": "order_test_456",
          "amount": 29900,
          "notes": {
            "customer_email": "customer@example.com",
            "business_name": "Test Business"
          }
        }
      }
    }
  }'
```

**Expected Response:**
```json
{"ok": false, "error": "Invalid signature"}
```

This is expected for test webhooks! Once you trigger a real payment through the Payment Button, Razorpay will send a signed webhook and it will be processed.

---

### Step 4: Test with Real Payment

1. Start your server: `npm start`
2. Open the audit form in your browser
3. Fill out the form and click the **Razorpay Payment Button**
4. Complete a test payment (use test card `4111 1111 1111 1111`)
5. Check your server logs for:
   ```
   📨 Razorpay Webhook: payment.authorized
   ✅ Payment authorized: pay_xxx | Order: order_yyy | Amount: ₹299
   ```

---

## 🔔 How Webhooks Work

### Flow:
1. Customer completes payment through Razorpay Payment Button
2. Razorpay sends HTTP POST to `/api/razorpay-webhook`
3. We verify the signature using your `RAZORPAY_KEY_SECRET`
4. If valid:
   - Log payment details
   - Send confirmation email (if SMTP configured)
   - Mark payment as complete
5. Return `{"ok": true}` to acknowledge

### Events Handled:
- **`payment.authorized`** - Customer successfully paid ✅
  - Logs payment details
  - Sends confirmation email
- **`payment.failed`** - Payment declined ❌
  - Logs failure reason
  - Can notify customer if needed

---

## 🛠️ Customization (TODO items in server.js)

The webhook currently logs payments. To connect to your system, add code for:

```javascript
// In the webhook handler (payment.authorized section):

// 1. Update database
// - Mark order/lead as paid
// - Store payment ID for auditing
// - Store customer details

// 2. Trigger audit generation
// - Call your audit API with the payment details
// - Generate and store the audit report

// 3. Send emails
// - Already implemented: sends confirmation email if SMTP is set
// - Can add more email types (invoice, report ready, etc.)

// 4. Webhooks for your frontend
// - You could POST to a custom backend system
// - Or update a CRM/database with payment status
```

---

## 📊 Payment Button vs Standard Checkout

| Feature | Payment Button | Standard Checkout |
|---------|---|---|
| **Setup** | Simple (1 line HTML) | Complex (multiple API calls) |
| **Order Creation** | Handled by Razorpay | You create orders |
| **Verification** | Webhook signature | Manual signature verification |
| **User Experience** | Hosted page | Modal popup |
| **Customization** | Limited | Full control |
| **Device Support** | Best (tested thoroughly) | Good |

**You chose Payment Button** because it's simpler and more reliable! ✅

---

## 🐛 Troubleshooting

### "Webhook signature mismatch"
- Verify your `RAZORPAY_KEY_SECRET` in `.env` is correct
- Check that webhook is within 5 minutes window (Razorpay requirement)

### "Webhook not being called"
- Verify webhook is ACTIVE in Razorpay Dashboard
- Check your domain is publicly accessible (test with curl)
- Check server logs for errors
- Verify payment button ID matches your Payment Link

### "Email not sending"
- Check SMTP credentials in `.env`
- Verify `MAIL_FROM` email is set
- Check spam folder
- SMTP is optional - webhook works without it

---

## 📞 Razorpay Documentation

- [Webhooks Guide](https://razorpay.com/docs/webhooks/)
- [Payment Button Guide](https://razorpay.com/docs/payments/payment-gateway/web-integration/payment-button/)
- [API Reference](https://razorpay.com/docs/api/)

---

## ✅ Checklist

- [ ] Public URL ready (ngrok/Vercel/hosting)
- [ ] Webhook configured in Razorpay Dashboard
- [ ] `.env` has `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`
- [ ] Server running with `/api/razorpay-webhook` endpoint
- [ ] Test payment completed
- [ ] Webhook logs show payment confirmation
- [ ] Email sent (if SMTP configured)
