// Verhaltenstests im echten Browser: Responsive-Server mit Beispieldaten + Chromium (headless).
// Eine Instanz je Testdatei: in before() starteBrowser(), in after() stop().
import { chromium } from 'playwright';
import { starteResponsiveServer } from '../responsive/server.js';

export async function starteBrowser() {
  const server = await starteResponsiveServer();
  const browser = await chromium.launch();
  const kontexte = [];
  return {
    server,
    async neueSeite(pfad, { als = 'test-4', breite = 1280, colorScheme } = {}) {
      const kontext = await browser.newContext({ viewport: { width: breite, height: 900 }, ...(colorScheme ? { colorScheme } : {}) });
      kontexte.push(kontext);
      const page = await kontext.newPage();
      const trenner = pfad.includes('?') ? '&' : '?';
      await page.goto(`${server.url}${pfad}${trenner}als=${als}`);
      return page;
    },
    async stop() {
      for (const k of kontexte) await k.close().catch(() => {});
      await browser.close();
      await server.stop();
    },
  };
}
