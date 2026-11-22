# Rails POS — change log

Every change to the app is recorded here, newest first. Each release has the
**app version** (the `CACHE_VERSION` in `sw.js` that devices update to) and
what changed, in plain words.

**Rule for whoever changes the code:** add an entry here in the same commit,
and bump `CACHE_VERSION` in `sw.js`.

| Symbol | Meaning |
|---|---|
| ✨ | New |
| 🔧 | Changed / improved |
| 🐞 | Fixed |
| 🔒 | Security |
| 🗄️ | Needs the Supabase SQL file re-run (`cloud/supabase-setup.sql`) |

---

## v34 — 2026-11-22 · Sale complete screen, calmer buttons and header

- ✨ After a sale, a clear **Sale complete** screen: a big tick, the total and payment method, the **change due in large numbers** for cash, and Print / WhatsApp / Email / Copy / **New sale** buttons. The slip is folded away under "Show receipt". New sale is selected, so pressing Enter starts the next sale.
- 🔧 Cash, Card and EFT now share one style with a small icon each; only the chosen one lights up.
- 🔧 The Charge button is a dashed outline that says "Add items to charge" while the cart is empty, then lights up with the amount in bold: "Charge **R549.00** · Cash".
- 🔧 The header pill no longer shows a pink "Not synced". Without cloud sync it is a calm grey "Saved on this device"; with cloud sync it says, for example, "Synced 2 min ago" (it updates every minute). On phones only the first word shows.
- 🔧 On tablets and computers, Settings and Admin sit at the bottom of the side menu, apart from the daily screens.
- 🔧 Product tiles can be a bit narrower on tablets and computers, so more fit across on wider screens.
- 🔧 The demo shop's address is now a neutral placeholder: "1, road name, city".

---

## v33 — 2026-11-22 · Friendlier empty cart

- 🔧 With nothing in the cart, the cart panel now shows the Rails POS logo, "Ready to sell", how many sales the till has done today and, if there are any, a button for the parked sales waiting. The rand total for today shows only to staff who may see reports, so a cashier on a blind cash-up still cannot see it.
- To go back to the old empty cart only: `git revert` this commit (the tile changes in v32 stay). The whole app before v32 is saved as the git tag `backup-v31`.

---

## v32 — 2026-11-22 · Clearer product tiles

- 🔧 Each category now has its own colour (the strip down the left of the tile) and a small clothing icon in the corner: shirt, pants, dress, jacket, shoe, bag, or a hanger for anything else. A product photo still takes that corner when there is one.
- 🔧 The stock badge now says "58 in stock" (green), "Only 2 left" (orange) or "Out of stock" (red), instead of a bare number.

---

## v31 — 2026-11-22 · Rails POS name on the till header

- 🔧 The header now shows the Rails POS logo and name, then a thin divider and the shop's own name. Before, the shop name replaced "Rails POS". On narrow phones only the logo and shop name show, so the header stays tidy.

---

## v30 — 2026-11-22 · Finer staff permissions (blind cash-up) and a Best sellers report
- 🔒 **Four new permissions** (Admin → edit a user):
  - **Products and prices** — add, edit, delete products and sizes, change prices, import. Split from **Stock counts and deliveries** (see stock, receive deliveries, adjust counts, stock take, labels), so a stock clerk can't change prices.
  - **Cash-up** — close the till. Without **Reports** the count is **blind**: no expected cash, no over / short, no Z-report shown; the owner sees the result in Reports and the activity log ("blind count").
  - **Petty cash** — its own permission (was part of Reports).
  - **Activity log** — can be given without full Admin.
- 🔒 **Cancelling a lay-by** (money back) now needs **Refunds and exchanges**.
- 🔧 Roles: **Cashier** = sales history, clients and lay-bys, cash-up (blind). **Manager** = everything except Admin (now incl. the activity log). Existing staff keep everything they could do: Stock → also Products and prices; Reports → also Cash-up and Petty cash; Admin and managers → also Activity log; cashiers → also Cash-up.
- 🔧 Screens and buttons follow the permissions: the Reports tab shows only Cash up / Petty cash for people without Reports; Stock hides + Product, Import, Edit and + Variant without Products and prices; Admin shows only the activity log without Admin.
- ✨ **Best sellers** (Reports → Top sellers → **See all**, and Print A4 → Best sellers): everything sold in the period, ranked by **items sold, sales value or profit**, **by product or by size & colour**, filter by category, with stock left. Print A4 or **download for Excel**.

## v29 — 2026-11-22 · Park a sale, petty cash, daily summary, activity log, stock take, client events, returns check
- ✨ **Park a sale** (fitting rooms): **Park** in the cart puts the sale aside with a name ("Lady in fitting room 2"); **Parked (n)** on the Sell screen brings it back. Kept on that till; items sold out meanwhile are left out with a warning.
- ✨ **Petty cash** (Reports → cash-up card): money paid out of the till for expenses (categories set in Settings → Shop floor) or cash added. Counted in the expected cash, shown on the cash-up and Z-report, synced.
- ✨ **Daily summary on WhatsApp**: one tap (Reports, or on the Z-report) sends the owner today's takings, cash/card/EFT, profit, discounts, lay-by payments, petty cash, best sellers, cash-ups over/short and overdue lay-bys. Owner's number in Settings → Shop floor.
- ✨ **Activity log** (Admin screen, owners): who gave discounts, refunds and exchanges, changed prices, adjusted or received stock, deleted products, cancelled lay-bys, cashed up (over/short), used petty cash, changed staff, imported stock, ran a stock take, restored or started fresh. Filter by person, kind and period. Synced, so it covers every till; kept when the shop starts fresh.
- ✨ **Full stock take** (Stock → Stock take): scan every item (USB scanner or camera) or type counts; continue later; review **missing / extra** with the value at cost; leave uncounted items or treat them as missing; print A4; apply as stock counts.
- ✨ **Client events** (wedding, matric dance, Eid…): event date on the client, shown on the profile with the final-fitting date; **Clients → Events** lists the next 60 days with lay-by money still owed and a one-tap WhatsApp message. Wording and fitting days in Settings → Lay-bys. A demo client has a wedding.
- ✨ **Returns-policy check**: the return screen says how long ago the sale was and warns when it's outside the shop's return period (Settings → Shop floor, default 7 days; 0 = no limit). Returns outside the period are marked in the activity log.
- 🐞 Pressing Enter in the stock take (as barcode scanners do) no longer jumps to the review.
- 🗄️ SQL: record types `expenses` and `activity`. Re-run `cloud/supabase-setup.sql`. (On-device database version 5.)

## v28 — 2026-11-22 · Full check; sharing fix for iPhone / iPad
- 🐞 **Email me my data** and **Share backup** on iPhone / iPad: Safari can refuse to open the share sheet because preparing the file takes a moment. The app now shows "Your file is ready" with a **Share** button; that tap always works.
- 🔧 Full check of the app: all screens at phone and tablet size, every slip type at 80 mm, 58 mm and WhatsApp width, all six A4 reports, statements, A4 and label-printer labels, import, reminders and the data export — no errors found.

## v27 — 2026-11-21 · Billing on the admin page; terms, subscription and privacy policy
- ✨ **Admin page billing:** each shop's **monthly fee** (R380 + R50 per extra device). Devices = those used in the last 30 days, or a number you set per shop (**Change**). "Monthly fees" total for paying shops.
- ✨ **Record payment** suggests the amount (fee × months covered) and can include the once-off **setup fee (R1 500, with 1 hour training)**.
- ✨ **Invoice** button per shop (1–12 months, optional setup fee, due date) and a **Receipt** for every recorded payment — A4, print or save as PDF. Your trading name, contact and **bank details** are saved in your browser only (never in the public code).
- ✨ **Terms, subscription and privacy policy** (`legal.html`): prices, trial, late payment, cancelling, terms of use, POPIA privacy policy, operator terms for shops' customer details, and a privacy notice shops can put up. Linked from the setup screen, shop-account sign-up and Settings → Subscription.
- 🗄️ SQL: `shops.billed_devices`, `vendor_set_devices`, `vendor_list_shops` returns devices used in the last 30 days, `vendor_shop_payments` returns the payment id (receipt numbers). Re-run `cloud/supabase-setup.sql`.

## v26 — 2026-11-21 · "Email me my data"; supplier number off customer slips
- ✨ **Settings → Your data → Email me my data:** one zip file with the whole shop as Excel files — `stock.csv` (in the same layout Stock → Import reads), `sales.csv`, `clients.csv`, `laybys.csv`, `layby-payments.csv`, `cashups.csv` — plus `backup.json` (full backup) and a "READ ME". On phones, tablets and Windows the share sheet opens (choose Mail / Gmail / Outlook); otherwise the file is saved and the email app opens to attach it. Counts as a backup.
- 🔧 Slips and A4 reports now just say **"Powered by Rails POS"**: the supplier's WhatsApp number was removed so shop customers don't call it. (The Renew / Subscribe buttons for shop owners still use it.)

## v25 — 2026-11-21 · "Powered by Rails POS" on slips and A4 reports
- ✨ Every receipt, lay-by slip, credit note, statement and Z-report ends with **"Powered by Rails POS · 073 314 2884"** (also on WhatsApp / email copies).
- ✨ Every A4 report and statement has **"Powered by Rails POS · till software for clothing shops · WhatsApp 073 314 2884"** in its footer.

## v24 — 2026-11-21 · Import stock, lay-by reminders, reorder list, staff commission
- ✨ **Import stock from Excel or CSV** (Stock → Import): choose an `.xlsx` or `.csv` file, or copy rows in Excel and paste them. One row per size/colour; only Name and Price are needed (Category, Size, Colour, Cost, Stock, SKU, Barcode, Description optional; headings matched loosely, e.g. "Qty", "Color", "Selling price"). Preview before importing, with problems listed by row. Products with the same name get the new sizes/colours; existing ones are skipped, or updated if ticked. Download a template. Opening stock is recorded as "Imported".
- ✨ **Lay-by reminders on WhatsApp:** Clients → **To remind** lists lay-bys that are overdue, due within 14 days, or have had no payment for 30 days (and weren't reminded in the last week). One tap opens WhatsApp with a friendly message; the reminder is recorded on the lay-by. "Remind on WhatsApp" is also on each open lay-by. The wording is in Settings → Lay-bys.
- ✨ **Reorder list** (Reports, and Print A4 → Reorder list): items that are low or will run out within 14 days at the period's selling rate, how long the stock lasts, and how many to buy for about 30 days, with the cost.
- ✨ **Staff sales & commission** (Reports, and Print A4 → Staff sales & commission): sales, items, refunds, net sales, average sale and commission per employee. Set the commission % on the Reports screen (owners/managers).

## v23 — 2026-11-21 · Till-slip receipts, receipt printers and label printers
- 🔧 **New receipt layout** (like a normal till slip): logo **centred** at the top, shop name, slogan, "Contact No:", invoice number with date and time, employee, **Qty · Description · Price · Total** columns, discount, **TOTAL (ZAR) in large print**, total excluding VAT / VAT / total including VAT, payments, **customer name and lay-by number in large print**, optional signature line, footer. Lay-by slips and payment receipts use the same layout.
- ✨ **Settings → Receipts & printers:** paper **80 mm** (42 characters) or **58 mm**; print the shop name under the logo or not; signature line; **print automatically** after each sale, lay-by and payment; **Print a test receipt**.
- ✨ **Slogan** under the shop name (Settings → Store).
- ✨ Receipts print at exactly the paper's width and length (no blank paper fed), for USB / network receipt printers installed in Windows. With the Edge shortcut in the user guide (`--kiosk-printing`) they print without the print window.
- ✨ **Label printer sizes** for barcode labels: 50 × 30, 40 × 30, 58 × 40, 50 × 25 mm or your own size; one label per sticker. The chosen size is remembered per device.
- 🔧 WhatsApp, email and Copy still send a narrow (32-character) version that fits a phone.

## v22 — 2026-11-20 · Choose the paid-until date when recording a payment
- 🔧 Admin page, **Record payment**: you now choose the **Paid until** date yourself (one month after the current end date is suggested), together with the paid-on date (can be backdated), amount, method and note. The paid-until date can't be before the payment date or more than 5 years ahead.
- 🔧 Removed the **+1 month** button. "Set date" and "No end date" remain for changes without a payment.
- 🔧 Payment history shows **Paid on** and **Paid until** for each payment.
- 🔧 The admin page asks browsers for fresh files after each update (`?v=` on its script and styles).
- 🗄️ SQL: `vendor_payments.paid_until`, new `vendor_record_payment_until` function, `vendor_shop_payments` returns the paid-until date. Re-run `cloud/supabase-setup.sql`.

## v21 — 2026-11-20 · Record (backdated) payments; deactivate / reactivate shops
- ✨ Admin page: **Record payment**, with paid-on date (can be in the past, not the future), months (1, 2, 3, 6, 12), amount, method (EFT / cash / card / other) and note. The paid-until date runs from the payment date, or from the current end date if that is later.
- ✨ **Payment history** per shop, **total paid**, last payment date, and **"Paid this month"** across all shops.
- ✨ **Deactivate / Reactivate** a shop, with an optional reason the shop sees. Deactivated shops pause selling on all their devices at the next sync (data kept; reports, backups and settings still work) and see a "Contact on WhatsApp" button. Shops can't change this themselves.
- 🔧 All changes, including payments and (de)activation, appear under Recent changes (audit log).
- 🗄️ SQL: `shops.deactivated` / `deactivated_reason`, `vendor_payments` table, `vendor_record_payment`, `vendor_shop_payments` and `vendor_set_active` functions. `vendor_list_shops` returns more columns. Re-run `cloud/supabase-setup.sql`.

## v20 — 2026-11-20 · Admin sign-in with password only
- 🔒 🔧 The supplier admin page no longer uses an authenticator app (owner's choice): sign in with the admin **email and password** only. Only logins listed in `vendor_admins` can use it; every change is still logged; the page still forgets the login when the tab closes and signs out after 15 minutes idle. Use a long (12+ characters), unique password.
- 🗄️ SQL: `vendor_check()` no longer requires two-step verification. Re-run `cloud/supabase-setup.sql`.

## v19 — 2026-11-20 · Supplier admin page and WhatsApp renewals
- ✨ **Supplier admin page** (`admin.html`, for you only): every shop with its login email, trial or paid status, paid-until date, number of tills and last activity. Buttons: **+1 / +3 / +12 months**, **set a date**, **no end date**. Recent changes are listed.
- 🔒 Only logins added to `vendor_admins` (by you, in Supabase) can use it, and the database also requires **two-step verification** (authenticator app code). Every change is written to an audit log. The page forgets the login when the tab closes and signs out after 15 minutes idle. Strict content-security policy. Never cached offline.
- ✨ **"Subscribe or renew on WhatsApp"** button (Settings → Subscription, and on expiry banners), to the supplier's WhatsApp Business number.
- 🗄️ SQL: `plan` column (trial / paid), `vendor_admins`, `vendor_audit`, `vendor_*` functions.
- ✨ `CHANGELOG.md` (this file) and the user guide (`docs/`, private).

## v18 — 2026-11-20 · Clients and lay-bys (first client: bridal / evening wear)
- ✨ **Clients** screen and **client profiles**: details, notes, store credit, lay-bys, purchases.
- ✨ **Lay-bys:** put items aside from the cart (any deposit, months to pay, default 3), add more items to an open lay-by later, take payments any time (cash / card / EFT / store credit). Overdue lay-bys are marked red but can still be paid.
- ✨ **Collect & invoice:** the tax invoice is made when the lay-by is collected and lists every payment.
- ✨ **Cancel a lay-by:** refund (optional fee), store credit, or the shop keeps the money. Items go back into stock.
- ✨ **Statements and lay-by slips:** WhatsApp, Email (opens the email app, addressed to the client), print, and an A4 statement with logo.
- ✨ **Shop details on receipts:** email, website, extra lines (reg. no., bank details) and **logo**. Product **descriptions** print under items.
- 🔧 Cash-up and Z-report include lay-by payments and refunds. Reports show lay-by money received, owed and overdue.
- 🔧 New permission "Clients and lay-bys". Owners, managers and cashiers get it automatically.
- 🔧 Demo data includes 3 clients (one with an overdue lay-by).
- 🗄️ SQL: record types `customers` and `laybys`.

## v17 — 2026-11-20 · Demo data for synced shops
- ✨ "Load demo data" works on a synced shop (e.g. a client's demo shop) and fills all its devices, keeping the shop's name, details and staff logins.
- 🐞 Loading demo data no longer restarts the free-trial clock.

## v16 — 2026-11-20 · Barcode labels and subscriptions
- ✨ **Barcode label sheets** (24 / 21 / 40 per A4, or plain paper): shop, product, size/colour, price, Code 128 barcode of the SKU.
- ✨ **Subscription check:** 14-day trial without a shop account, 30-day trial for new shops, reminders, 7 days' grace, then selling pauses (data stays usable).
- 🗄️ 🔒 SQL: shops can't change their own paid-until date or delete themselves. One shop per login.

## v15 — 2026-11-20 · Setup screen, camera scanning, photos
- ✨ **First-time setup** on new devices (set up my shop / try demo / join my shop). No built-in login any more.
- ✨ **Camera barcode scanning** with the app's own reader (EAN-13, UPC-A, EAN-8, Code 128). Tag barcodes can be saved per size/colour.
- ✨ Small **product photos** on tiles, cart, picker and stock.
- 🔧 Neon colours softened a little.

## v14 — 2026-11-20 · Connected to Supabase
- 🔧 Cloud sync connected to the shop database. Tests never touch the real database.

## v13 — 2026-11-20 · Cloud sync and backup
- ✨ **Cloud sync** between devices via Supabase: sales, stock, products, settings and staff logins. Works offline and catches up later.
- ✨ Till letters for unique receipt numbers (A-00012, B-00003). Each till cashes up its own drawer.
- ✨ A wiped or new device signs in and gets everything back.
- 🗄️ First version of `cloud/supabase-setup.sql`.

## v12 — 2026-11-20 · Neon look
- 🔧 Neon theme (default) with glowing Cash / Card / EFT buttons. Light look kept for bright sunlight.

## v11 — 2026-11-20 · Better reports
- ✨ More periods, comparison with the previous period, takings chart, categories, cashiers, VAT summary, green money.
- ✨ **A4 printouts:** sales summary, sales list, stock on hand, cash-ups.

## v10 — 2026-11-20 · Navy & coral look (later replaced)

## v9 — 2026-11-20 · Admin screen (users and permissions)
- ✨ Add, rename and delete staff, reset PINs. Roles: Owner, Manager, Cashier, Custom.

## v8 — 2026-11-20 · Sign-in
- ✨ Sign-in with username and 4-digit PIN, Lock button, change PIN, "Served by" on receipts.

## v1–v7 — 2026-11-20 · First version
- ✨ Offline till for clothing shops:
  - selling with sizes and colours, VAT tax invoices and credit notes
  - returns and exchanges, stock history, reports, cash-up and Z-reports
  - backup, restore and CSV export
  - one-tab protection, update prompt, automated tests
