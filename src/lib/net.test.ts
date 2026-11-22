import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicUrl,
  decodeHtmlEntities,
  dedupeArticleImages,
  imageKey,
  isPrivateIp,
  sanitizeArticleHtml,
} from "./net.ts";

test("decodes HTML entities left in CDATA titles", () => {
  // Ars Technica / The Verge ship titles inside CDATA, so entities arrive as literal text
  assert.equal(
    decodeHtmlEntities("California isn&#039;t allowed at AT&amp;T"),
    "California isn't allowed at AT&T",
  );
  assert.equal(decodeHtmlEntities("Rockstar&#8212;really"), "Rockstar—really");
  // No ampersand: returned unchanged, no DOM parse
  assert.equal(decodeHtmlEntities("Plain title"), "Plain title");
  assert.equal(decodeHtmlEntities(""), "");
});

test("blocks private and metadata IP ranges", async () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("169.254.169.254"), true);
  assert.equal(isPrivateIp("192.168.1.5"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("93.184.216.34"), false);

  await assert.rejects(() => assertPublicUrl("http://localhost:3000/secret"));
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/"));
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"));
});

test("blocks encoded and alternate-spelling private hosts, allows a public URL", async () => {
  // What a reader would paste / what an attacker would try, all of which must not be fetched.
  await assert.rejects(() => assertPublicUrl("http://localhost:3000"));
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/"));
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"));
  await assert.rejects(() => assertPublicUrl("http://10.0.0.1"));
  await assert.rejects(() => assertPublicUrl("http://[::1]/"));
  await assert.rejects(() => assertPublicUrl("http://192.168.1.1/admin"));
  await assert.rejects(() => assertPublicUrl("http://172.16.0.1/"));

  // Same address, other spellings. The URL parser canonicalises them; the guard still sees a
  // private literal rather than a hostname.
  const privateIp = { message: /Private IP addresses are not allowed/ };
  await assert.rejects(() => assertPublicUrl("http://2130706433/"), privateIp, "decimal IPv4");
  await assert.rejects(() => assertPublicUrl("http://0x7f.0.0.1/"), privateIp, "hex IPv4");
  await assert.rejects(() => assertPublicUrl("http://0177.0.0.1/"), privateIp, "octal IPv4");
  await assert.rejects(() => assertPublicUrl("http://127.1/"), privateIp, "short-form IPv4");
  assert.equal(isPrivateIp("0x7f000001"), true);

  // Suffixed local names and non-http schemes.
  await assert.rejects(() => assertPublicUrl("http://printer.local/"));
  await assert.rejects(() => assertPublicUrl("http://metadata.google.internal/"));
  await assert.rejects(() => assertPublicUrl("ftp://example.com/feed.xml"));

  const publicUrl = await assertPublicUrl("https://example.com/feed.xml");
  assert.equal(publicUrl.hostname, "example.com");
});

test("sanitizes scripts, ads/iframes, tracking pixels, and resolves relative URLs", () => {
  const dirty = `
    <p>Hello <a href="/story">world</a></p>
    <script>alert(1)</script>
    <iframe src="https://ads.example.com/banner"></iframe>
    <img src="https://track.example.com/pixel.gif" width="1" height="1" />
    <img src="/images/hero.jpg" alt="Hero" />
  `;
  const clean = sanitizeArticleHtml(dirty, "https://example.com/posts/1");

  assert.doesNotMatch(clean, /<script/i);
  assert.doesNotMatch(clean, /<iframe/i);
  assert.doesNotMatch(clean, /pixel\.gif/i);
  assert.match(clean, /href="https:\/\/example\.com\/story"/);
  assert.match(clean, /src="https:\/\/example\.com\/images\/hero\.jpg"/);
  assert.match(clean, /rel="noopener noreferrer"/);
});

test("treats the same photo under different CDN URLs as one image", () => {
  assert.equal(
    imageKey("https://ichef.bbci.co.uk/news/1024/branded_news/photo.jpg?w=1200&q=80"),
    imageKey("https://ichef.bbci.co.uk/news/480/branded_news/photo.jpg"),
  );
  assert.notEqual(
    imageKey("https://example.com/a/photo.jpg"),
    imageKey("https://example.com/b/photo.jpg"),
  );
});

test("strips the lead photo from the body so the hero renders only once", () => {
  const body = `
    <p>Lead in.</p>
    <figure><img src="https://cdn.example.com/hero.jpg?w=1200" /><figcaption>The photo</figcaption></figure>
    <p>Second paragraph.</p>
    <figure><img src="https://cdn.example.com/diagram.png" /><figcaption>A chart</figcaption></figure>
    <p>Third paragraph.</p>
  `;

  const { contentHtml, heroImage } = dedupeArticleImages(
    body,
    "https://cdn.example.com/hero.jpg",
    "https://example.com/story",
  );

  assert.equal((contentHtml.match(/hero\.jpg/g) ?? []).length, 0, "lead photo removed from body");
  assert.match(contentHtml, /diagram\.png/);
  assert.match(contentHtml, /Second paragraph/);
  assert.equal(heroImage, "https://cdn.example.com/hero.jpg");
});

test("collapses a body image that repeats further down the article", () => {
  const body = `
    <p>One.</p>
    <img src="https://cdn.example.com/chart.png" />
    <p>Two.</p>
    <img src="https://cdn.example.com/chart.png?w=800" />
  `;
  const { contentHtml } = dedupeArticleImages(body, undefined, "https://example.com/story");
  assert.equal((contentHtml.match(/chart\.png/g) ?? []).length, 1, "duplicate body image dropped");
});
