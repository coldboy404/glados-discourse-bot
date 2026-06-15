const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
  return browser;
}

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/*', async (req, res) => {
  const cookieStr = req.query._cookie || '';
  const target = 'https://linux.do' + req.path + '?' + req.url.split('?')[1] || '';
  
  // Try direct fetch first
  try {
    const r = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (r.ok) {
      const text = await r.text();
      try { return res.json(JSON.parse(text)); } catch { return res.send(text); }
    }
  } catch {}

  // Need browser for CF challenge
  const b = await getBrowser();
  const ctx = await b.newContext();
  try {
    if (cookieStr) {
      const pairs = cookieStr.split(';').map(p => p.trim().split('='));
      ctx.addCookies(pairs.filter(p => p[1]).map(p => ({
        name: p[0], value: p[1], domain: '.linux.do', path: '/'
      })));
    }
    // Load saved cookies
    if (fs.existsSync('/data/cookies.json')) {
      ctx.addCookies(JSON.parse(fs.readFileSync('/data/cookies.json','utf8')));
    }
    const page = await ctx.newPage();
    await page.goto(target, { waitUntil: 'networkidle', timeout: 35000 });
    await page.waitForTimeout(2000);
    fs.writeFileSync('/data/cookies.json', JSON.stringify(await ctx.cookies(), null, 2));
    const text = await page.evaluate(() => document.body.innerText);
    try { res.json(JSON.parse(text)); } catch { res.send(text); }
  } finally { await ctx.close(); }
});

app.listen(PORT, () => console.log('LD Proxy on :' + PORT));