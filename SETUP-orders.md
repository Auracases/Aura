# Saving orders to your Google Sheet

This connects the "Place Order" button to a Google Sheet, so every order
becomes a row and every uploaded photo lands in a Drive folder.

## A) One-time setup

### 1. Make the Drive folder for photos
1. Go to **drive.google.com** → **New → Folder** → name it `CaseBari Orders Photos`.
2. Open the folder. Look at the address bar:
   `https://drive.google.com/drive/folders/`**`1AbC...XyZ`**
   The bold part after `/folders/` is the **folder ID**. Copy it.

### 2. Make the Orders sheet + script
1. Go to **sheets.google.com** → blank sheet → name it `CaseBari Orders`.
2. **Extensions → Apps Script**. Delete whatever code is there.
3. Open `apps-script.gs` from this project, copy ALL of it, paste into the editor.
4. At the top, replace `PASTE_DRIVE_FOLDER_ID_HERE` with the folder ID from step 1.
5. Click the **Save** icon.

### 3. Deploy it as a Web App
1. Top-right: **Deploy → New deployment**.
2. Click the gear next to "Select type" → choose **Web app**.
3. Fill in:
   - **Description:** `CaseBari orders`
   - **Execute as:** **Me** (your email)
   - **Who has access:** **Anyone**
4. Click **Deploy**.
5. It asks to authorize → **Authorize access** → pick your Google account →
   "Google hasn't verified this app" → **Advanced → Go to (project) → Allow**.
   (This is normal — it's your own script.)
6. Copy the **Web app URL** (ends in `/exec`).

### 4. Connect the site
1. Open `config.js`.
2. Set `ORDER_ENDPOINT` to that `/exec` URL:
   ```js
   ORDER_ENDPOINT: "https://script.google.com/macros/s/AKfy.../exec",
   ```
3. Also set `BKASH_NUMBER` to your real bKash/Nagad number.
4. Save. Done.

> **If you ever change `apps-script.gs`:** in Apps Script do
> **Deploy → Manage deployments → (pencil/edit) → Version: New version → Deploy.**
> Editing the code without a new version does nothing on the live URL.

## B) Test checklist (do these on a real Android phone)

**Mobile number validation**
- [ ] Type `0171` → Place Order stays disabled, error "Enter an 11-digit number starting with 01."
- [ ] Type `017123456789` (12 digits) → trimmed to 11, only digits accepted.
- [ ] Type `12345678901` (no `01`) → error shows.
- [ ] Type a valid `01712345678` → error clears.

**Delivery charge switching**
- [ ] Open checkout with one item → bill shows subtotal only, prompt to pick area.
- [ ] Tap **Inside Dhaka** → delivery `৳70`, grand total = subtotal + 70.
- [ ] Tap **Outside Dhaka** → delivery `৳130`, grand total updates live.

**Payment method (no advance — same for all)**
- [ ] With a custom-photo item in cart, payment section still shows only
      **Cash on Delivery** / **bKash/Nagad** — no advance message anywhere.
- [ ] Choose **bKash/Nagad** → confirmation shows your `BKASH_NUMBER` and
      "put your order ID … as the reference".
- [ ] Choose **Cash on Delivery** → confirmation says "pay … when it arrives".

**Successful order lands in the sheet**
- [ ] Add a normal design + a custom-photo case, fill the form, Place Order.
- [ ] Button shows the spinner, then the confirmation screen with an Order ID `CB…`.
- [ ] Open the Google Sheet → a new row: timestamp, order ID, name, mobile,
      area, address, payment method, items, photo link, total.
- [ ] Click the photo link → the uploaded photo opens in Drive (compressed JPEG).
- [ ] After success, the cart is empty (count badge back to 0).

**Failure / retry (never lose typed data)**
- [ ] In `config.js` temporarily set `ORDER_ENDPOINT` to a wrong URL
      (e.g. add `XXX` to the end). Save, reload.
- [ ] Fill the form, Place Order → error "Couldn't place order — check your
      internet and try again." appears, button re-enables.
- [ ] Confirm the form still has the name, mobile, area, address you typed.
- [ ] Fix the URL, reload, Place Order again → succeeds.
