# Test Hoolam on your own phone

Real WhatsApp, pretend money. About 30 minutes, all free. You'll set up three things:

| | What | Why |
|---|---|---|
| A | **Supabase** | the database |
| B | **Meta WhatsApp test number** | the WhatsApp number people chat with |
| C | **Render** | puts the server online so WhatsApp can reach it |

Keep a note open: you'll copy six values along the way.

---

## A. Database (Supabase), 5 minutes

1. Sign up at **supabase.com** and create a **New project**.
   - Region: **Frankfurt (eu-central-1)**, the closest to Lagos.
   - Set a database password and save it.
2. When it's ready, click **Connect** at the top.
3. Choose the **Session pooler** string (not "Direct connection": that one doesn't work from Render).
   It looks like `postgresql://postgres.abcd:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`.
4. Replace `[YOUR-PASSWORD]` with your password. **Save this as `DATABASE_URL`.**

Hoolam creates its own tables the first time it starts.

## B. WhatsApp test number (Meta), 10 minutes

1. Go to **developers.facebook.com**, log in, **My Apps → Create app**.
2. Choose the use case for **WhatsApp** (connecting with customers on WhatsApp). Pick or create a business portfolio when asked.
3. Open **WhatsApp → API Setup**. Meta gives you a free test number. Copy:
   - the **Phone number ID** → save as `WHATSAPP_PHONE_NUMBER_ID`
   - the **temporary access token** → save as `WHATSAPP_TOKEN` (it lasts 24 hours)
   - the test number itself, digits only, no `+` → save as `WHATSAPP_PUBLIC_NUMBER`
4. Under **To**, add **your own WhatsApp number** and enter the code WhatsApp sends you.
   (Testing with a second person? Add their number too. Up to 5.)
5. Go to **App settings → Basic**, click **Show** next to App secret → save as `WHATSAPP_APP_SECRET`.

## C. Put the server online (Render), 10 minutes

1. Sign up at **render.com** with your GitHub account (Levinders).
2. **New → Blueprint**, choose the **hoolam** repo. Render reads `render.yaml` from the repo.
3. It asks for the values you saved: `DATABASE_URL`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_APP_SECRET`, `WHATSAPP_PUBLIC_NUMBER`. Paste them and click **Apply**.
4. Wait for the deploy to finish (a few minutes). Open `https://<your-app>.onrender.com/health`.
   You should see `"ok":true` and `"testMode":true`.
5. In Render, open **Environment** and copy the generated **WHATSAPP_VERIFY_TOKEN** and **ADMIN_TOKEN**.

## D. Connect WhatsApp to the server, 2 minutes

1. Back in Meta: **WhatsApp → Configuration → Webhook → Edit**.
   - Callback URL: `https://<your-app>.onrender.com/webhook/whatsapp`
   - Verify token: the `WHATSAPP_VERIFY_TOKEN` from Render
   - Click **Verify and save**. (If the server was asleep, wait a minute and click again.)
2. Under **Webhook fields**, **Subscribe** to **messages**.
3. Click **Test** next to **messages**. Render's logs should show `whatsapp in: …1181 text` (the reply then fails
   with "not in allowed list", which is expected for Meta's sample number).
4. **Attach your WhatsApp Business account to the app.** Without this, Meta's Test works but your real messages
   never arrive. Run once, with the WhatsApp Business account ID from API Setup and your access token:

   ```
   curl -X POST "https://graph.facebook.com/v26.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer <TOKEN>"
   ```

   You should get `{"success":true}`.

## E. Run a deal from your phone

Message the test number on WhatsApp. One phone plays both sides:

1. Send **hi** → tap **Sell something** → type the item → the price → `0123456789 GTBank` → **Yes, that's me** → **Create deal**.
2. Send `Pay HL-XXXXX` (the code Hoolam gave you), or tap the link.
3. Tap **Pay now**, then reply **paid** to pretend the transfer landed.
4. Tap **I've sent it**, then **I'm happy**. You'll get "You've been paid".

Try **Problem** instead of I'm happy to test the dispute flow.

## When something doesn't work

| What you see | Likely cause | Fix |
|---|---|---|
| No reply at all, and nothing in Render's logs | WhatsApp account not attached to the app | Run the `subscribed_apps` command in step D4 |
| No reply at all, server was idle | Server asleep (free plan) | Wait a minute and send again |
| Render log shows `bad signature` | Wrong `WHATSAPP_APP_SECRET` | Copy it again from App settings → Basic |
| Replies stopped after a day | The temporary token expired | Generate a new one in API Setup, update `WHATSAPP_TOKEN` in Render |
| Messages "not delivered" | Your number isn't in the **To** list | Add and verify it in API Setup |

To see what Hoolam tried to send and any error from WhatsApp:

```
curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://<your-app>.onrender.com/admin/messages
```

Render's **Logs** tab shows a line like `whatsapp in: …1234 text` for every message that arrives.

**Later:** a permanent token (Meta "System user"), your own business number, and turning off test mode
(`ALLOW_SELF_DEAL=false`) once Monnify keys are in.
