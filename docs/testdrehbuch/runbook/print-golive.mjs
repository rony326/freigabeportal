import { chromium } from 'playwright';
const [,, src, out] = process.argv;
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('file://' + src);
await p.pdf({ path: out, format: 'A4', printBackground: true, preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: '<div style="font-size:7pt;color:#8c959f;width:100%;padding:0 14mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>Go-Live-Checkliste Freigabeportal</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>' });
await b.close();
