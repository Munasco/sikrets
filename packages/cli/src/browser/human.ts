import type { Locator, Page } from "playwright-core";

// Human-paced input: every keystroke and pointer move goes through here so flows read like a
// person using the site, and a watcher can follow each step on screen.

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Roughly normal around `mean`, clamped, so delays cluster instead of spreading evenly.
const around = (mean: number, spread: number) => {
  const n = (Math.random() + Math.random() + Math.random()) / 3;
  return Math.max(mean * 0.35, mean + (n - 0.5) * 2 * spread);
};

export const pause = (mean = 600, spread = 250) => sleep(around(mean, spread));

const cursor = new WeakMap<Page, { x: number; y: number }>();

/** Moves the pointer along a slightly curved, eased path ending a little off-center on the target. */
export async function moveTo(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error("Element is not visible");
  const to = { x: box.x + box.width * rand(0.3, 0.7), y: box.y + box.height * rand(0.35, 0.65) };
  const from = cursor.get(page) ?? { x: rand(80, 400), y: rand(80, 300) };
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  // Control point pushed sideways from the straight line gives a gentle arc.
  const bend = rand(-0.25, 0.25) * dist;
  const ctrl = {
    x: (from.x + to.x) / 2 + bend * ((to.y - from.y) / (dist || 1)),
    y: (from.y + to.y) / 2 - bend * ((to.x - from.x) / (dist || 1)),
  };
  const steps = Math.max(12, Math.min(60, Math.round(dist / 12)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease in-out
    const x = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * ctrl.x + e ** 2 * to.x;
    const y = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * ctrl.y + e ** 2 * to.y;
    await page.mouse.move(x, y);
    await sleep(rand(6, 16));
  }
  cursor.set(page, to);
}

export async function click(page: Page, target: Locator) {
  await moveTo(page, target);
  await pause(160, 80);
  await page.mouse.down();
  await sleep(rand(50, 120));
  await page.mouse.up();
}

/** Clicks into the field, then types one key at a time with uneven rhythm and the odd longer pause. */
export async function type(page: Page, target: Locator, text: string) {
  await click(page, target);
  await pause(300, 120);
  for (const ch of text) {
    await page.keyboard.type(ch);
    let delay = around(95, 45);
    if (ch === " " || ch === "@" || ch === ".") delay += rand(40, 160);
    if (Math.random() < 0.04) delay += rand(250, 700); // brief hesitation
    await sleep(delay);
  }
}

export async function press(page: Page, key: string) {
  await pause(250, 100);
  await page.keyboard.press(key);
}
