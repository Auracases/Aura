/* ====================================================================
   CASEBARI — Orders backend (Google Apps Script)
   Attach this to your Orders Google Sheet (Extensions -> Apps Script),
   then deploy as a Web App. Step-by-step is in SETUP-orders.md.

   What it does:
   - Receives one order as JSON (sent with Content-Type text/plain).
   - Saves any uploaded photos (base64 JPEG) to a Drive folder.
   - Appends ONE row per order to the active sheet.
   - Returns JSON { ok: true, orderId }.
   ==================================================================== */

// >>> EDIT ME <<< paste the ID of the Drive folder where photos should go.
// (Open the folder in Drive; the ID is the part of the URL after /folders/)
const PHOTO_FOLDER_ID = "PASTE_DRIVE_FOLDER_ID_HERE";

// One header row, written automatically the first time a row is added.
const HEADERS = [
  "Timestamp", "Order ID", "Name", "Mobile", "Area", "Address",
  "Payment Method", "Items", "Photo Links", "Total (BDT)"
];

function doPost(e) {
  try {
    const order = JSON.parse(e.postData.contents);

    // ----- save photos to Drive, collect shareable links -----
    const links = [];
    if (order.photos && order.photos.length) {
      const folder = DriveApp.getFolderById(PHOTO_FOLDER_ID);
      order.photos.forEach(function (p, i) {
        // dataUrl looks like "data:image/jpeg;base64,XXXX" — strip the prefix.
        const base64 = String(p.dataUrl).split(",").pop();
        const bytes = Utilities.base64Decode(base64);
        const name = p.name || (order.orderId + "_" + (i + 1) + ".jpg");
        const blob = Utilities.newBlob(bytes, "image/jpeg", name);
        const file = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        links.push(file.getUrl());
      });
    }

    // ----- summarize all items into one cell -----
    const itemsText = (order.items || []).map(function (it) {
      const nm = it.name ? (' name "' + it.name + '"') : "";
      const photo = it.hasPhoto ? " [custom photo]" : "";
      return it.caseType + " — " + it.model + " · " + it.design + nm + photo + " · BDT " + it.price;
    }).join("\n");

    // ----- append the row -----
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);

    sheet.appendRow([
      new Date(),
      order.orderId,
      order.name,
      order.mobile,
      order.area === "insideDhaka" ? "Inside Dhaka" : "Outside Dhaka",
      order.address,
      order.paymentMethod,
      itemsText,
      links.join("\n"),
      order.total
    ]);

    return json({ ok: true, orderId: order.orderId });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// Helper: return a JSON response.
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
