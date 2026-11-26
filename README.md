# Rails POS: offline point of sale for small clothing stores

Rails POS is a till for small South African clothing shops. It runs in the browser, keeps working with no internet (load-shedding, patchy signal) and can be installed on a phone or tablet home screen. Each device keeps a full copy of the shop, and with cloud sync turned on, all devices share sales, stock and settings through a Supabase database.

## Features

- **Selling**
  - Search by name or SKU. A barcode scanner works too: it types the SKU and presses Enter, and the item is added.
  - Pick size and colour, change quantities, give a discount in rand or percent, and take cash, card or EFT with change worked out.
  - You can't sell more than is in stock.
  - Product tiles show the photo, or a clothing icon in a soft colour per category, and say "58 in stock", "Only 2 left" or "Out of stock".
  - The empty cart shows today's sales (the rand total only for staff who may see reports) and any parked sales.
  - After charging, a **Sale complete** screen shows the change due in large numbers, with Print, WhatsApp, Email, Copy and New sale.
- **Tax-correct slips**
  - A VAT-registered shop prints a TAX INVOICE with its VAT number.
  - Sales over R5,000 ask for the buyer's name and address (needed for a full tax invoice).
  - Refunds print a CREDIT NOTE.
  - A shop that isn't VAT-registered prints a plain RECEIPT with no VAT on it.
- **Returns and exchanges**
  - Return some or all of the items on a sale, refunded by cash, card or EFT.
  - For an exchange, the returned items become a credit in the cart. The customer pays the difference, or any unused credit is paid back in cash.
- **Stock**
  - Products have size and colour variants. A variant can have its own price (for example, XXL costs more).
  - Use +/- or type a quantity, filter for low stock, and receive a supplier delivery in one go.
  - Every stock change is kept in a history: sold, returned, adjusted, counted, received.
- **Reports and cash-up**
  - Reports for today, yesterday, 7 days, 30 days, this month or any dates you choose, with refunds counted on the day they happen.
  - Money in green (refunds and losses in red), ▲/▼ comparison with the previous period on every headline number, takings per hour or per day (with average line, best and quietest day), busiest weekdays, profit margin, payment split, categories with profit and margin, top sellers, cashiers and a VAT summary. A jump bar at the top goes straight to each section.
  - **Stock health:** stock value at cost and selling price, **slow movers** (not sold in 60 days, or far more stock than sales) with the money tied up, and **sizes that sell** per category.
  - A4 printouts (or PDF from the print screen): sales summary, sales list for the bookkeeper, stock on hand with cost and selling value, and cash-ups.
  - Cash-up at the end of a shift: expected cash vs counted cash, over/short, the float for the next shift, and a printable Z-report.
- **Receipts**
  - Every receipt, credit note and Z-report can be sent on WhatsApp, copied or printed.
- **Cloud sync and backup** (Supabase)
  - Every device of a shop shares sales, stock, products, settings and staff users. Changes arrive within about 20 seconds, and straight away when you open Reports or Sales.
  - Works offline: sales are queued and sent when the connection returns. The header shows Synced 2 min ago, Syncing…, Offline · 3 waiting, or Sync problem (and a calm grey "Saved on this device" when cloud sync isn't on).
  - **Devices online:** Settings → Cloud sync lists the shop's devices (till letter, type, who is signed in, online now or last seen). On tablets and computers the header also shows "Devices online 2". A device drops off as soon as the app is closed or the screen locks.
  - Stock stays right when two tills sell the same item at once: devices sync stock *movements* (−1, +1 …) and each device adds them up.
  - Each device is a till with its own letter, so receipt numbers never clash (A-00012, B-00003). Each till cashes up its own drawer, and Reports show the whole shop.
  - A new, lost or wiped device signs in with the shop email and gets everything back.
- **Data safety**
  - Backup to a JSON file (download, copy or share) and restore from a file or pasted JSON.
  - Sales export to CSV.
  - A weekly reminder to back up.
  - An unfinished cart is saved, so a dead battery doesn't lose the sale in progress.
- **Safety in use**
  - Only one tab can be open at a time, so two copies can't overwrite each other.
  - When a new version is downloaded, the app shows "A new version is ready" and switches over only when you tap Reload.
- **First-time setup**
  - A new device asks: *Set up my shop* (shop name, owner name, 4-digit PIN), *Try it with demo data*, or *My shop already uses Rails POS* (sign in to the shop's cloud and download everything, including staff logins). There is no built-in account.
- **Barcodes and photos**
  - **Scan** button on the Sell screen uses the phone/tablet camera. Android/Chrome use the device's built-in reader; iPhone/iPad use the app's own reader (EAN-13, UPC-A, EAN-8 tag barcodes and Code 128 SKU labels, read with a check digit and two agreeing lines).
  - Each size/colour can store the **barcode printed on its tag** (Stock → tap the size → Barcode → Scan). USB/Bluetooth scanners work too (they type the code + Enter).
  - Optional **product photo**, shrunk to a 160 × 160 picture (about 3–10 KB) and shown small on the till, cart, picker and stock list.
- **Clients and lay-bys**
  - **Clients** screen: search, overdue first, totals owed. Each client has a profile with their details, notes, store credit, lay-bys and purchases.
  - **Lay-by** button in the cart: choose or create the client, set the months to pay (default in Settings, 3), and take any deposit (no minimum) by cash, card, EFT or store credit. Items come off stock straight away.
  - Add more items to an existing open lay-by later. Take any number of payments. Overdue lay-bys are marked red but can still be paid.
  - **Collect & invoice** when paid in full creates the tax invoice listing every payment (VAT is counted at collection). Lay-by payments are shown separately in Reports and counted in the cash-up.
  - **Cancel:** refund (optionally minus a fee), store credit, or the shop keeps the money. Items go back into stock.
  - **Statements and slips:** WhatsApp, **Email** (opens the email app, already addressed), print, or an A4 statement with logo (save as PDF to attach).
- **Shop details on receipts:** name, address, phone, email, website, extra lines (reg. no., bank details), VAT number, and the **shop logo** (printed slips, screen, A4). Product **descriptions** print under each item.
- **Barcode labels**
  - Stock → **Labels** (all products) or a product's **Labels** button. Choose how many of each size (or "Quantity = stock" / "1 of each"), the sheet (24, 21 or 40 per A4 sheet, or plain paper to cut out) and where to start on a half-used sheet.
  - Each label shows the shop name, product, size/colour, price, a Code 128 barcode of the SKU and the SKU. It scans with the camera or a USB scanner. Print at **100% / Actual size** with **no margins**.
- **Shop floor and control** (v29)
  - **Park a sale** for customers in the fitting room, and bring it back later.
  - **Petty cash** paid out of or added to the till, counted in the cash-up.
  - **Daily summary on WhatsApp** to the owner: takings, payment split, profit, lay-bys, petty cash, cash-ups over/short.
  - **Activity log** (Admin): who gave discounts, refunds, price and stock changes, deletions, cash-ups, staff changes.
  - **Full stock take** with a missing / extra report (value at cost) and A4 print.
  - **Client events** (wedding, matric dance…) with a final-fitting date and WhatsApp reminders.
  - **Returns-policy check**: warns when a return is outside the shop's return period.
- **Subscription (licence)**
  - A device without a shop account has a **14-day free trial**. A new cloud shop gets **30 days free**, then follows its paid-until date (`shops.active_until`, set by the supplier in Supabase; shops can't change it). No date means no end.
  - Reminder in the last 7 days. After the date there are 7 days' grace, then **selling pauses**: Charge is disabled, but reports, backups and settings still work. The date is checked on every sync and remembered offline.
  - A shop **deactivated** by the supplier pauses selling on all its devices at the next sync (data kept) and shows a "Contact on WhatsApp" button. **Renew on WhatsApp** buttons go to the supplier's WhatsApp Business number (`SUPPLIER` in `app.js`).
  - Subscriptions are managed on the supplier admin page (below).
- **Supplier admin page** (`admin.html`, for the Rails POS supplier only)
  - Sign in with the admin email and password (no authenticator app). Only logins listed in the `vendor_admins` table get in; everything else is refused by the database.
  - Every shop with its login email, trial / paid status, paid-until date, tills, last activity, total paid and last payment. Totals: shops, paid this month, shops needing attention, deactivated.
  - **Record payment:** paid-on date (can be backdated), the **paid-until** date you choose, amount, method and note. **Payment history** per shop. **Set date** / **No end date** without a payment. **Deactivate** (with a reason the shop sees) and **Reactivate**.
  - **Online now:** how many of each shop's devices are open right now (v37).
  - **Billing:** monthly fee per shop (R380 + R50 per extra device; devices used in the last 30 days, or a number you set), suggested payment amounts, the once-off setup fee (R1 500), printable **invoices** and **payment receipts** (A4 or PDF). Your bank details for invoices are saved only in your browser. Prices are in `PRICES` at the top of `admin.js`.
  - Every change is written to an audit log (Recent changes). The page forgets the login when the tab closes, signs out after 15 minutes idle, has a strict content-security policy and is never cached offline.
  - Add an admin once in Supabase → SQL Editor: `insert into public.vendor_admins (user_id) select id from auth.users where email = 'your@email';`
- **Sign-in**
  - The till is covered by a sign-in screen: username (not case-sensitive) and a 4-digit PIN.
  - You stay signed in when the page reloads or updates; closing the app or tapping the lock button in the header asks again.
  - Five wrong PINs in a row pause sign-in for 30 seconds. The PIN can be changed under **Settings, then Account**.
  - PINs are stored only as PBKDF2 hashes, separately from shop data, so backups, restores and Start fresh never touch them.
  - Each sale records who was signed in ("Served by" on the receipt).
- **Admin: users and access**
  - Add, rename and delete users, and reset their PIN.
  - Each user gets a role: Owner (everything), Manager (everything except Admin), Cashier (sell, sales history, clients and lay-bys, blind cash-up) or Custom.
  - Tick or untick each permission: discounts, refunds and exchanges (incl. cancelling lay-bys), sales history, clients and lay-bys, stock counts and deliveries, products and prices, cash-up, petty cash, reports, activity log, settings and backups, admin. Selling is always allowed.
  - **Blind cash-up:** someone with Cash-up but not Reports counts the drawer without seeing the expected cash or over / short.
  - **Best sellers** report (Reports → Top sellers → See all, A4, Excel): ranked by items sold, value or profit, by product or size & colour.
  - **Profit checker add-on** (Reports, v39, R150 a month): opens Rails Profit checker full screen with the shop's own sales, refunds, cost prices and stock loaded (profit per product, loss-makers and break-even prices, slow stock, run-out dates, best day to promote, price slider, WhatsApp summary). Online sellers can add Takealot/Amazon/Excel/PDF files too. A shop on a paid plan can start a 14-day free trial once; the supplier turns it on, changes the trial date or blocks it from the admin page, and tills pick that up within about 20 seconds (offline: up to 3 days after the last check). Reading PDF or Excel files downloads their readers from cdnjs/jsDelivr the first time; files are never uploaded.
  - **From your till** (v40, inside the Profit checker): sold-out sizes that sell and sizes that sit, stock older than 90 days, estimated missed sales while sizes were sold out, what discounts cost (per staff member), return reasons, busiest hours and sales per staff member, regular clients, and **real profit** after petty cash and the monthly running costs (saved in Settings), with the sales needed to break even. Each product has a size-by-size table.
  - **Return reasons** (v40): optional when refunding or exchanging (wrong size or fit, changed mind, faulty, other). Faulty items aren't put back in stock, and in Reports their cost stays a cost (v41).
  - **Paused accounts** (v42): when an account is deactivated, the subscription has ended, a till hasn't been online for 7 days, or the device date is wrong, Sell shows a full-screen "send proof of payment" message (email from the admin page, WhatsApp, Check again). Reports, backups and Settings still work.
  - Screens and buttons a user may not use are hidden, and every action is checked again when tapped. A cashier's cart ignores any discount.
  - You can't delete yourself, and there is always at least one user with Admin access.
  - This keeps staff and customers out of the till. It is not copy protection: a licence check needs a server (see *What to build next*).
- **Sounds** (v48)
  - Soft sounds for the key moments: a tick when an item goes in the cart, a chime when a sale is complete or a lay-by is collected, a chime for lay-by payments, coins at cash-up, and a low tone when something is refused. Ordinary buttons stay silent.
  - **Settings → Shop floor → Sounds on this device:** Off, Soft, Normal (default) or Loud, per device. Made in the app (Web Audio), so nothing is downloaded.
- **Receipt barcode** (v50)
  - Every printed sale receipt (58 and 80 mm) and the on-screen receipt end with a Code 128 barcode of the receipt number: `R` + the number, e.g. `R00025` (`RA-00025` with cloud series letters). Drawn by the app as an SVG (`barcodeSvg`), so no barcode font is needed. WhatsApp, email and copied receipts stay plain text.
  - **Sales → Scan receipt** (camera), or a USB/Bluetooth scanner typing into the Sales search + Enter, opens that sale with Return / exchange. Scanning a receipt on the Sell screen opens it too, without touching the cart. `findSaleByCode` also accepts the plain number (`00025`, `25`).
- **Usable by everyone**
  - A premium boutique look (v49): Playfair Display for names, totals and headings and Inter for text, both saved in `fonts/` (open licence) so they work offline; a blush header and side menu with a gold "R" monogram, compact raised buttons, round − / + in the cart, a gold-tick "Sale complete", rose low-stock pills and gentle motion (off when the device asks for reduced motion). Receipts and printouts keep their own fonts. A Dark look (near-black with rose buttons) is in Settings → Appearance.
  - Keyboard and screen-reader friendly dialogs.
  - Colours checked for WCAG AA contrast.

## Files

| File | What it is |
|---|---|
| `index.html` | Page structure and icons |
| `app.css` | Styles: mobile-first, light/dark, tablet layout from 860px |
| `app.js` | All app logic, in numbered sections (see the map at the top) |
| `sw.js` | Service worker: caches the app so it opens offline |
| `manifest.json` | Makes the app installable |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | App icons (the maskable one keeps the logo inside Android's round crop) |
| `admin.html`, `admin.js`, `admin.css` | Supplier admin page (subscriptions, billing, invoices, receipts, deactivation) |
| `legal.html` | Terms, prices, subscription and POPIA privacy policy (linked in the app) |
| `cloud/supabase-setup.sql` | The whole cloud database; safe to re-run after each change |
| `CHANGELOG.md` | Every release, newest first |
| `tests.html` | Automated tests that run in any browser |
| `profit/` | Rails Profit checker (the paid add-on), copied from the separate app. Don't edit here: change it in `Rails - Charts`, then run `sh tools/copy-profit-checker.sh` |
| `tools/copy-profit-checker.sh` | Copies Rails Profit checker into `profit/` |
| `tools/serve.ps1` | A tiny local web server for Windows when Python isn't installed |

There is no build step, framework, CDN or web font. (The Profit checker add-on loads PDF and Excel readers from a CDN only when a shop opens such a file there.)

## Run it locally

```powershell
python -m http.server 8000
```

If Python isn't installed, use the PowerShell server instead:

```powershell
pwsh -File tools/serve.ps1 -Port 8000
```

Then open http://localhost:8000. Offline mode only works over `http://localhost` or `https://`, not by opening the file directly.

## Run the tests

With the server running, open **http://localhost:8000/tests.html** and click **Run all tests**, or open `tests.html?auto` to run them straight away.

The tests drive the real app (clicks, typing, reloads, a second tab) using a **separate test database**, so your shop data is never touched. All 43 tests should pass (one runs two "devices" against a fake Supabase to test syncing; one reads drawn barcodes that are blurred, noisy and upside down). They cover:
- sign-in, lock and changing the PIN
- admin: adding, editing and deleting users, and what a cashier can't do
- selling and stock
- partial returns, exchanges and cancelled exchanges
- report numbers
- VAT on/off and changing the VAT rate
- tax invoices over R5,000
- stock history, deliveries and stock counts
- the saved cart and data persisting after a reload
- cash-up
- the one-tab lock
- backup and restore
- CSV export
- accessibility and colour contrast
- clients and lay-bys (payments, overdue, collect, cancel)
- barcodes, labels, photos and the licence check
- cloud sync and the supplier admin page (against a fake Supabase), including the Profit checker add-on: trial, block, payments and invoices
- upgrading data from version 1

## Put it on a phone (free hosting)

Phones only allow offline mode and home-screen install over **HTTPS**, so host the files first.

### Cloudflare Pages (easiest)
1. Sign up at https://pages.cloudflare.com
2. Choose **Create a project, then Direct Upload**, and drag in: `index.html`, `app.css`, `app.js`, `sw.js`, `manifest.json`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, and the `profit` folder. Leave out `tools/`, `.claude/` and `tests.html`.
3. You get a URL like `https://rails-pos.pages.dev`.

### GitHub Pages
Push the files to a repository, then go to **Settings, then Pages, then Deploy from branch** and choose `main` / root. All paths are relative, so `https://you.github.io/repo/` works.

### Install
- **iPhone:** open the URL in **Safari**, tap **Share**, then **Add to Home Screen**. Always open it from the home-screen icon. Data in a normal Safari tab is kept separately, and iOS may delete it if the site isn't used for 7 days.
- **Android:** open the URL in Chrome, tap ⋮, then **Install app**.
- Open it once while online. After that it works with no signal.

### Cloud sync set-up (once)
1. Create a free project at https://supabase.com.
2. Open **SQL Editor → New query**, paste all of [`cloud/supabase-setup.sql`](cloud/supabase-setup.sql) and click **Run**.
3. Under **Authentication → URL Configuration**, set **Site URL** to the app's address (e.g. `https://you.github.io/rails-pos/`). That's where the "confirm your email" link sends people.
4. Copy the **Project URL** and the **anon / publishable key** into `CLOUD` at the top of `app.js`. Both are meant to be public; row-level security keeps each shop's data private. Never put the `service_role` key in the app.
5. In the app: **Settings → Cloud sync → Create shop account** on the first device, then **Sign in** with the same email on every other device.

Free-tier note: a Supabase free project pauses after a week with no activity (a shop selling daily keeps it awake). Move to a paid plan before you have paying customers.

### Releasing an update
Change the files, **add an entry to `CHANGELOG.md` and bump `CACHE_VERSION` in `sw.js`**, then upload. If `cloud/supabase-setup.sql` changed, run the whole file again in Supabase. Phones download the update in the background and show *"A new version is ready — Reload now"*. Nothing changes in the middle of a sale. If you forget to bump the version, phones keep the old files.

## How it works

- **Money** is stored as whole cents. Prices include VAT, so the VAT in a total is `total × rate ÷ (100 + rate)`. If a sale has a discount, refunds share the discount out pro rata. When the last item of a sale is returned, the refunds add up to exactly the amount paid.
- **Storage** uses IndexedDB, with one record per product, sale, stock movement and cash-up, plus settings, counters and the cart. A sale is saved in one transaction together with its stock changes, movements and the receipt counter, so it can't half-save. Data from version 1 is migrated automatically.
- **Each sale stores a snapshot** of prices, costs and the store's details (name, address, VAT number). Later edits don't change old invoices.
- **One tab at a time:** a Web Lock makes sure only one tab writes data. Any other tab shows "already open", with a button to take over (the first tab saves and pauses).
- **Reports:** net revenue = sales − refunds. Gross profit = net revenue ex VAT − cost of the goods kept by customers.
- **Cash-up:** expected cash = opening float + cash sales − cash refunds − exchange credit paid out in cash.
- **Security:** all user text is escaped before it goes into HTML. CSV text cells starting with `= + - @` are prefixed with `'` so spreadsheets don't run them as formulas.

## Where future features plug in

Search `app.js` and `sw.js` for `PLUG-IN:`.

| Feature | Where |
|---|---|
| Licence / subscription check | `shops.active_until` in `cloud/supabase-setup.sql`; check it in `syncNow()` |
| Background sync while the app is closed | a `sync` event in `sw.js` |
| Card terminal (Yoco / SumUp / iKhokha) | `checkout()`: call the terminal before saving |
| Bluetooth / ESC-POS printer | `printDoc()` |
| Licence check / cloud accounts | `checkLogin()` in section 14b of `app.js` |
| New permissions | `PERMISSIONS`, `ROLES` and `ACTION_PERMS` in `app.js` |
| Multiple branches | `DEFAULT_SETTINGS`: add `storeId` and stamp it on sales |

## Tax notes (check with your accountant)

- SARS lets a VAT vendor issue an abridged tax invoice for sales up to R5,000. Above R5,000 a full tax invoice needs the buyer's name, address and VAT number (if they have one). The app asks for these automatically.
- Refunds produce a numbered credit note that references the original invoice.
- Businesses with taxable turnover under R1 million a year usually don't have to register for VAT. If you aren't registered, untick **VAT registered** in Settings.

## Known limitations

- Without cloud sync, data lives only on the device. Clearing the browser's website data deletes it. **Back up weekly**, or turn on cloud sync.
- With cloud sync, two devices editing the *same* product or the same sale's returns at the same moment: the last save wins. Stock is not affected, because it is summed from movements.
- Email opens the email app with the text (no automatic sending yet). There is no "forgot password" for shop logins yet.
- Printing uses the browser print dialog. Small thermal printers need the Bluetooth integration.
- Very old browsers without Web Locks (Safari before 15.4) don't get the one-tab protection.
- The receipt layout is 32 characters wide (58mm paper). 80mm printers will show it narrower than they could.

## What to build next

Already built: licence check, cloud sync, barcode labels and camera scanning, cashier logins, clients and lay-bys, product photos, supplier admin page.

1. **Forgot password** for shop logins, with a proper email service (custom SMTP) for confirmation and reset emails.
2. **Automatic email** of receipts and statements (today the email app opens with the text).
3. **Bluetooth thermal printer (ESC-POS)** and a cash drawer kick.
4. **Card machine integration** (Yoco, SumUp, iKhokha).
5. **Online renewals** (PayFast / Yoco payment link that updates the paid-until date).
6. **Loyalty**, and cash-ups per cashier.
7. **Purchase orders and suppliers**, building on the "Receive delivery" screen.
8. **Multi-branch** with stock transfers.
