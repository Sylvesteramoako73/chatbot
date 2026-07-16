import * as cheerio from "cheerio";

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

/**
 * Breadth-first crawl of a site, staying on the same origin. Strips
 * script/style/nav/footer before extracting text so boilerplate doesn't
 * pollute the knowledge base.
 */
export async function crawlSite(startUrl: string, maxPages = 50): Promise<CrawledPage[]> {
  const origin = new URL(startUrl).origin;
  const visited = new Set<string>();
  const queue: string[] = [startUrl];
  const pages: CrawledPage[] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    let html: string;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "WebsiteChatbotCrawler/1.0" },
      });
      const contentType = res.headers.get("content-type") ?? "";
      if (!res.ok || !contentType.includes("text/html")) continue;
      html = await res.text();
    } catch {
      continue;
    }

    const $ = cheerio.load(html);
    $("script, style, nav, footer, noscript").remove();
    const title = $("title").first().text().trim() || url;
    const text = $("body").text().replace(/\s+/g, " ").trim();
    if (text) pages.push({ url, title, text });

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      try {
        const abs = new URL(href, url);
        abs.hash = "";
        if (abs.origin === origin && !visited.has(abs.href) && !queue.includes(abs.href)) {
          queue.push(abs.href);
        }
      } catch {
        // ignore malformed URLs
      }
    });
  }

  return pages;
}
