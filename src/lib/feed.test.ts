import assert from "node:assert/strict";
import test from "node:test";
import { buildSyntheticFeed } from "../api/feed.ts";

const page = "https://news.example.com/";

// A grid cell wraps two stories: headline A (text only) and story B (photo + headline). Walking up
// from A used to hand A the photo that belongs to B — the reported bug.
const sharedCell = `
  <section class="grid">
    <div class="cell">
      <article><a href="/news/2026/11/22/climate-summit-collapses-after-late-deal">
        <h2>Climate summit collapses after late deal fails</h2></a></article>
      <article>
        <figure><img src="/pictures/soccer-team-celebrates-title.jpg"></figure>
        <a href="/news/2026/11/22/soccer-team-wins-the-league-final">
          <h2>Soccer team wins the league final at home</h2></a>
      </article>
    </div>
  </section>
`;

test("a shared grid cell gives no story its neighbour's photo", () => {
  const feed = buildSyntheticFeed(sharedCell, page);
  assert.ok(feed);
  const climate = feed.items.find((item) => item.title.startsWith("Climate summit"));
  const soccer = feed.items.find((item) => item.title.startsWith("Soccer team"));
  assert.ok(climate && soccer, "both stories are items");
  assert.equal(climate.image, undefined, "climate story borrows nothing");
  assert.match(soccer.image ?? "", /soccer-team-celebrates-title\.jpg$/);
});

test("a card that wraps one story keeps its own photo", () => {
  const card = `
    <div class="card">
      <a href="/news/2026/11/22/cop31-ends-without-agreement">
        <img src="/pictures/cop31-delegates.jpg">
        <h2>COP31 ends without an agreement on fossil fuels</h2>
      </a>
    </div>
  `;
  const feed = buildSyntheticFeed(card, page);
  assert.ok(feed);
  assert.match(feed.items[0]?.image ?? "", /cop31-delegates\.jpg$/);
});

test("one picture is never shown under two headlines", () => {
  const twice = `
    <div>
      <article><a href="/news/2026/11/22/first-story-about-the-summit">
        <img src="/pictures/shared-hero.jpg"><h2>First story about the summit collapse</h2></a></article>
      <article><a href="/news/2026/11/22/second-story-about-the-summit">
        <img src="/pictures/shared-hero.jpg"><h2>Second story about the summit collapse</h2></a></article>
    </div>
  `;
  const feed = buildSyntheticFeed(twice, page);
  assert.ok(feed);
  assert.equal(feed.items.filter((item) => item.image).length, 1, "first claimant wins");
});

test("a placeholder image is not a story photo", () => {
  const card = `
    <div class="card">
      <img src="/assets/grey-placeholder.png">
      <img src="/pictures/real-story-photo.jpg">
      <a href="/news/2026/11/22/story-with-a-real-photo"><h2>Story that ships a placeholder first</h2></a>
    </div>
  `;
  const feed = buildSyntheticFeed(card, page);
  assert.ok(feed);
  assert.match(feed.items[0]?.image ?? "", /real-story-photo\.jpg$/);
});
