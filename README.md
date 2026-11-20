# Rails POS: offline point of sale for small clothing stores

Rails POS is a till for small South African clothing shops. It runs in the browser, keeps working with no internet (load-shedding, patchy signal) and can be installed on a phone or tablet home screen. All data stays on the device.

## Features

- **Selling**
  - Search by name or SKU. A barcode scanner works too: it types the SKU and presses Enter, and the item is added.
  - Pick size and colour, change quantities, give a discount in rand or percent, and take cash, card or EFT with change worked out.
  - You can't sell more than is in stock.
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
  - Reports for today, 7 days and 30 days, with refunds counted on the day they happen.
  - Cash-up at the end of a shift: expected cash vs counted cash, over/short, the float for the next shift, and a printable Z-report.
- **Receipts**
  - Every receipt, credit note and Z-report can be sent on WhatsApp, copied or printed.
- **Data safety**
  - Backup to a JSON file (download, copy or share) and restore from a file or pasted JSON.
  - Sales export to CSV.
  - A weekly reminder to back up.
  - An unfinished cart is saved, so a dead battery doesn't lose the sale in progress.
- **Safety in use**
  - Only one tab can be open at a time, so two copies can't overwrite each other.
  - When a new version is downloaded, the app shows "A new version is ready" and switches over only when you tap Reload.
- **Sign-in**
  - The till is covered by a sign-in screen: username (not case-sensitive) and a 4-digit PIN.
  - You stay signed in when the page reloads or updates; closing the app or tapping the lock button in the header asks again.
  - Five wrong PINs in a row pause sign-in for 30 seconds. The PIN can be changed under **Settings, then Account**.
  - PINs are stored only as PBKDF2 hashes, separately from shop data, so backups, restores and Start fresh never touch them.
  - Each sale records who was signed in ("Served by" on the receipt).
- **Admin: users and access**
  - Add, rename and delete users, and reset their PIN.
  - Each user gets a role: Owner (everything), Manager (everything except Admin), Cashier (sell and see sales) or Custom.
  - Tick or untick each permission: discounts, refunds and exchanges, sales history, stock, reports and cash-up, settings and backups, admin. Selling is always allowed.
  - Screens and buttons a user may not use are hidden, and every action is checked again when tapped. A cashier's cart ignores any discount.
  - You can't delete yourself, and there is always at least one user with Admin access.
  - This keeps staff and customers out of the till. It is not copy protection: a licence check needs a server (see *What to build next*).
- **Usable by everyone**
  - Light and dark mode.
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
| `icon-192.png`, `icon-512.png` | App icons |
| `tests.html` | Automated tests that run in any browser |
| `tools/serve.ps1` | A tiny local web server for Windows when Python isn't installed |

There is no build step, framework, CDN or web font.

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

The tests drive the real app (clicks, typing, reloads, a second tab) using a **separate test database**, so your shop data is never touched. All 26 tests should pass. They cover:
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
- upgrading data from version 1

## Put it on a phone (free hosting)

Phones only allow offline mode and home-screen install over **HTTPS**, so host the files first.

### Cloudflare Pages (easiest)
1. Sign up at https://pages.cloudflare.com
2. Choose **Create a project, then Direct Upload**, and drag in: `index.html`, `app.css`, `app.js`, `sw.js`, `manifest.json`, `icon-192.png`, `icon-512.png`. Leave out `tools/`, `.claude/` and `tests.html`.
3. You get a URL like `https://rails-pos.pages.dev`.

### GitHub Pages
Push the files to a repository, then go to **Settings, then Pages, then Deploy from branch** and choose `main` / root. All paths are relative, so `https://you.github.io/repo/` works.

### Install
- **iPhone:** open the URL in **Safari**, tap **Share**, then **Add to Home Screen**. Always open it from the home-screen icon. Data in a normal Safari tab is kept separately, and iOS may delete it if the site isn't used for 7 days.
- **Android:** open the URL in Chrome, tap ⋮, then **Install app**.
- Open it once while online. After that it works with no signal.

### Releasing an update
Change the files **and bump `CACHE_VERSION` in `sw.js`**, then upload. Phones download the update in the background and show *"A new version is ready — Reload now"*. Nothing changes in the middle of a sale. If you forget to bump the version, phones keep the old files.

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
| Cloud sync | `DB.write()` in `app.js` (queue ops in an outbox), and a `sync` event in `sw.js` |
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

- Data lives only on the device until cloud sync is built. **Back up weekly.**
- Printing uses the browser print dialog. Small thermal printers need the Bluetooth integration.
- Very old browsers without Web Locks (Safari before 15.4) don't get the one-tab protection.
- The receipt layout is 32 characters wide (58mm paper). 80mm printers will show it narrower than they could.

## What to build next

1. **Licence check**: a small server that confirms the shop's subscription when online, so the app can't simply be copied.
2. **Cloud backup and sync** (Google Drive or a small server). This is the biggest remaining data-safety gap.
2. **Bluetooth thermal printer (ESC-POS)** and a cash drawer kick.
3. **Barcode labels** for SKUs, and the camera as a scanner.
4. **Card machine integration** (Yoco, SumUp, iKhokha).
5. **Cashier logins with PINs**, with cash-ups per cashier.
6. **Customers and lay-bys:** WhatsApp numbers, purchase history, loyalty, and lay-by deposits.
7. **Product photos**, stored compressed on the device.
8. **Purchase orders and suppliers**, building on the "Receive delivery" screen.
9. **Multi-branch** with stock transfers.
