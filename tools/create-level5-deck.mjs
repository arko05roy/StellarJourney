import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const ROOT = new URL("../", import.meta.url).pathname;
const OUT = `${ROOT}docs/level-5`;
const PREVIEW = `${ROOT}.artifacts/level5/deck`;
const HOME = `${ROOT}.artifacts/level5/screenshots/paymap-home.png`;
const MERCHANT = `${ROOT}.artifacts/level5/screenshots/paymap-merchant-connect.png`;
const W = 1280;
const H = 720;
const C = {
  ink: "#101114",
  muted: "#5E6573",
  line: "#D9DEE8",
  paper: "#F7F8FA",
  white: "#FFFFFF",
  blue: "#2563EB",
  blueSoft: "#E8F0FF",
  green: "#0F9F6E",
  amber: "#E69C2D",
};

const deck = Presentation.create({ slideSize: { width: W, height: H } });

function shape(slide, geometry, x, y, w, h, fill = "none", line = "none", radius) {
  return slide.shapes.add({
    geometry,
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: { style: "solid", fill: line, width: line === "none" ? 0 : 1 },
    ...(radius ? { borderRadius: radius } : {}),
  });
}

function text(slide, value, x, y, w, h, size = 24, color = C.ink, bold = false, align = "left") {
  const box = shape(slide, "textbox", x, y, w, h);
  box.text = value;
  box.text.style = {
    fontSize: size,
    color,
    bold,
    fontFamily: "Aptos",
    alignment: align,
  };
  return box;
}

function title(slide, eyebrow, heading, subheading) {
  text(slide, eyebrow.toUpperCase(), 72, 54, 500, 24, 13, C.blue, true);
  text(slide, heading, 72, 92, 1120, 68, 40, C.ink, true);
  if (subheading) text(slide, subheading, 72, 164, 1040, 46, 18, C.muted);
  shape(slide, "rect", 72, 690, 1136, 2, C.line);
}

function footer(slide, n) {
  text(slide, "PAYMAP · LEVEL 5", 72, 672, 240, 16, 10, C.muted, true);
  text(slide, String(n).padStart(2, "0"), 1164, 672, 44, 16, 10, C.muted, true, "right");
}

function notes(slide, body, sources = []) {
  const sourceBlock = sources.length ? `\n\nSources:\n${sources.map((s) => `- ${s}`).join("\n")}` : "";
  slide.speakerNotes.textFrame.setText(`${body}${sourceBlock}`);
}

async function imageBytes(path) {
  const b = await fs.readFile(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function card(slide, x, y, w, h, number, heading, body, accent = C.blue) {
  shape(slide, "roundRect", x, y, w, h, C.white, C.line, "rounded-xl");
  shape(slide, "ellipse", x + 24, y + 24, 40, 40, accent);
  text(slide, number, x + 24, y + 31, 40, 22, 15, C.white, true, "center");
  text(slide, heading, x + 24, y + 82, w - 48, 34, 23, C.ink, true);
  text(slide, body, x + 24, y + 124, w - 48, h - 148, 16, C.muted);
}

// 1 — title
{
  const s = deck.slides.add();
  s.background.fill = C.paper;
  shape(s, "roundRect", 742, 80, 466, 540, C.ink, C.ink, "rounded-2xl");
  shape(s, "ellipse", 852, 168, 246, 246, C.blue);
  shape(s, "ellipse", 925, 241, 100, 100, C.ink);
  text(s, "PAYMAP", 72, 70, 300, 26, 15, C.blue, true);
  text(s, "Programmable\npayments.\nUser control.", 72, 142, 610, 248, 54, C.ink, true);
  text(s, "Non-custodial recurring payments on Stellar.", 72, 426, 560, 54, 22, C.muted);
  text(s, "Level 5 submission deck · July 2026", 72, 592, 450, 26, 14, C.muted);
  text(s, "BOUNDED\nAUTHORITY", 814, 474, 330, 62, 19, C.white, true, "center");
  footer(s, 1);
  notes(s, "Open with the user promise: recurring payments without surrendering wallet custody.", [
    "https://github.com/SachPlayZ/Paymap",
  ]);
}

// 2 — problem
{
  const s = deck.slides.add();
  s.background.fill = C.paper;
  title(s, "Problem", "Recurring crypto payments force a bad tradeoff.", "Automation usually means custody, unlimited approvals, or repeated manual signing.");
  const items = [
    ["01", "Custody risk", "Merchants or intermediaries may control funds or keys."],
    ["02", "Unlimited approval", "Blanket token allowances expose more than one payment."],
    ["03", "Poor recovery", "Users struggle to pause, revoke, or understand failed charges."],
  ];
  items.forEach(([n, h, b], i) => card(s, 72 + i * 378, 252, 350, 300, n, h, b, i === 1 ? C.amber : C.blue));
  footer(s, 2);
  notes(s, "Frame the product around a clear trust boundary, not a generic payments pitch.", [
    "https://github.com/SachPlayZ/Paymap/blob/main/docs/threat-model.md",
    "https://github.com/SachPlayZ/Paymap/blob/main/docs/contract-invariants.md",
  ]);
}

// 3 — solution
{
  const s = deck.slides.add();
  s.background.fill = C.paper;
  title(s, "Solution", "A mandate defines exactly what may happen.", "The user signs bounded terms once; merchants request charges inside those limits.");
  const xs = [72, 454, 836];
  const data = [
    ["1", "Authorize", "Payer sets merchant, asset, amount, cadence, caps, and expiry."],
    ["2", "Charge", "Relayer submits a merchant request. Contract verifies every bound."],
    ["3", "Control", "Payer can inspect, pause, resume, or revoke from the dashboard."],
  ];
  data.forEach((d, i) => card(s, xs[i], 250, 344, 314, ...d, i === 2 ? C.green : C.blue));
  footer(s, 3);
  notes(s, "Walk through the three-step user model. Emphasize that the relayer has zero spending authority.", [
    "https://github.com/SachPlayZ/Paymap/blob/main/docs/architecture.md",
    "https://github.com/SachPlayZ/Paymap/blob/main/docs/security-checklist.md",
  ]);
}

// 4 — product
{
  const s = deck.slides.add();
  s.background.fill = C.paper;
  title(s, "Product", "One product, two clean journeys.", "Consumers manage mandates. Merchants create checkout links and request eligible charges.");
  const home = await imageBytes(HOME);
  const merchant = await imageBytes(MERCHANT);
  shape(s, "roundRect", 72, 238, 548, 340, C.white, C.line, "rounded-xl");
  shape(s, "roundRect", 660, 238, 548, 340, C.white, C.line, "rounded-xl");
  s.images.add({ blob: home, contentType: "image/png", alt: "Paymap consumer interface", fit: "cover", position: { left: 84, top: 250, width: 524, height: 260 }, geometry: "roundRect", borderRadius: "rounded-lg" });
  s.images.add({ blob: merchant, contentType: "image/png", alt: "Paymap merchant connection interface", fit: "cover", position: { left: 672, top: 250, width: 524, height: 260 }, geometry: "roundRect", borderRadius: "rounded-lg" });
  text(s, "CONSUMER", 94, 528, 130, 18, 11, C.blue, true);
  text(s, "Inspect and control every mandate.", 94, 550, 480, 22, 16, C.ink, true);
  text(s, "MERCHANT", 682, 528, 130, 18, 11, C.blue, true);
  text(s, "Create payment flows without custody.", 682, 550, 480, 22, 16, C.ink, true);
  footer(s, 4);
  notes(s, "Demo both roles. Start at the public frontend, then enter the merchant connection flow.", [
    "https://paymap-web.vercel.app",
    "https://paymap-web.vercel.app/merchant/connect",
  ]);
}

// 5 — architecture
{
  const s = deck.slides.add();
  s.background.fill = C.paper;
  title(s, "Architecture", "Authorization stays on-chain; operations stay observable.", "A separated frontend, API, queue, relayer, indexer, and contract keep trust boundaries explicit.");
  const nodes = [
    [72, 266, 190, "Frontend", "Vercel"],
    [302, 266, 190, "Merchant API", "Render"],
    [532, 266, 190, "Queue + Relayer", "Render"],
    [762, 266, 190, "Soroban Contract", "Stellar Testnet"],
    [992, 266, 190, "Indexer", "Payments + events"],
  ];
  nodes.forEach(([x, y, w, h, b], i) => {
    shape(s, "roundRect", x, y, w, 150, i === 3 ? C.blue : C.white, i === 3 ? C.blue : C.line, "rounded-xl");
    text(s, h, x + 18, y + 28, w - 36, 30, 18, i === 3 ? C.white : C.ink, true, "center");
    text(s, b, x + 18, y + 74, w - 36, 40, 13, i === 3 ? C.blueSoft : C.muted, false, "center");
    if (i < 4) {
      shape(s, "rect", x + w, y + 72, 40, 3, C.line);
      shape(s, "ellipse", x + w + 35, y + 66, 12, 12, C.blue);
    }
  });
  text(s, "Payer signature", 72, 454, 190, 22, 12, C.blue, true, "center");
  text(s, "Scoped API key", 302, 454, 190, 22, 12, C.blue, true, "center");
  text(s, "Zero spending authority", 532, 454, 190, 22, 12, C.blue, true, "center");
  text(s, "Bounded enforcement", 762, 454, 190, 22, 12, C.blue, true, "center");
  text(s, "Confirmed state", 992, 454, 190, 22, 12, C.blue, true, "center");
  footer(s, 5);
  notes(s, "Explain the request path, then the confirmed-chain reconciliation path. The API never invents payment state.", [
    "https://github.com/SachPlayZ/Paymap/blob/main/docs/architecture.md",
    "https://developers.stellar.org/docs/networks",
  ]);
}

// 6 — proof
{
  const s = deck.slides.add();
  s.background.fill = C.paper;
  title(s, "Technical proof", "A working testnet system—not a slideware prototype.", "Evidence already in the repository; growth evidence remains a separate Level 5 gate.");
  const proofs = [
    ["20+", "meaningful commits", C.blue],
    ["8", "webhook event types", C.green],
    ["3", "scheduled retry windows", C.amber],
  ];
  proofs.forEach(([value, label, color], i) => {
    const x = 72 + i * 378;
    shape(s, "roundRect", x, 248, 350, 190, C.white, C.line, "rounded-xl");
    text(s, value, x + 24, 278, 302, 72, 46, color, true);
    text(s, label.toUpperCase(), x + 24, 364, 302, 24, 12, C.muted, true);
  });
  shape(s, "roundRect", 72, 470, 1106, 110, C.ink, C.ink, "rounded-xl");
  text(s, "LIVE", 98, 497, 74, 22, 12, C.green, true);
  text(s, "paymap-web.vercel.app", 182, 492, 430, 34, 22, C.white, true);
  text(s, "Testnet transaction hashes and E2E results are linked in the README.", 98, 536, 780, 22, 15, "#C7CCD6");
  footer(s, 6);
  notes(s, "Show the live application and repository evidence. Do not present 50-user growth as complete until genuine responses exist.", [
    "https://github.com/SachPlayZ/Paymap",
    "https://paymap-web.vercel.app",
    "https://github.com/SachPlayZ/Paymap/blob/main/docs/demo-script.md",
  ]);
}

// 7 — market + growth
{
  const s = deck.slides.add();
  s.background.fill = C.paper;
  title(s, "Market + growth", "Start where trust blocks repeat usage.", "Focus on teams already accepting stablecoins but missing safe recurring authorization.");
  const segments = [
    ["01", "Subscriptions", "SaaS, creator memberships, and recurring services."],
    ["02", "Installments", "Education, commerce, and milestone-based plans."],
    ["03", "Platforms", "Marketplaces and tools embedding merchant payments."],
  ];
  segments.forEach((d, i) => card(s, 72 + i * 378, 240, 350, 236, ...d, i === 2 ? C.green : C.blue));
  text(s, "ACQUIRE", 72, 518, 120, 18, 11, C.blue, true);
  text(s, "Merchant pilots → shared checkout links → verified user cohorts → integration partners", 72, 544, 1106, 34, 18, C.ink, true);
  footer(s, 7);
  notes(s, "This is a focused go-to-market hypothesis, not a market-size claim. Validate segments through the Level 5 feedback cohort.", [
    "https://github.com/SachPlayZ/Paymap/blob/main/docs/roadmap.md",
  ]);
}

// 8 — roadmap
{
  const s = deck.slides.add();
  s.background.fill = C.paper;
  title(s, "Roadmap", "Convert feedback into measured product decisions.", "Every phase has an evidence gate and a linked implementation commit.");
  const steps = [
    ["NOW", "50-user cohort", "Collect wallets, ratings, use cases, and verified testnet transactions."],
    ["NEXT", "Feedback iteration", "Rank friction by frequency and severity. Ship onboarding and reliability fixes."],
    ["THEN", "Production hardening", "Load/failure testing, alerting, recovery drills, and mainnet readiness review."],
  ];
  steps.forEach(([tag, h, b], i) => {
    const x = 72 + i * 378;
    shape(s, "roundRect", x, 244, 350, 284, i === 0 ? C.blueSoft : C.white, i === 0 ? C.blue : C.line, "rounded-xl");
    text(s, tag, x + 24, 272, 302, 22, 12, C.blue, true);
    text(s, h, x + 24, 316, 302, 34, 23, C.ink, true);
    text(s, b, x + 24, 372, 302, 104, 16, C.muted);
  });
  footer(s, 8);
  notes(s, "Describe the feedback loop: collect, analyze, prioritize, implement, verify, link the commit.", [
    "https://github.com/SachPlayZ/Paymap/blob/main/docs/level-5/google-form-spec.md",
    "https://github.com/SachPlayZ/Paymap/blob/main/docs/level-5/submission-evidence.md",
  ]);
}

// 9 — close
{
  const s = deck.slides.add();
  s.background.fill = C.ink;
  text(s, "PAYMAP", 72, 70, 280, 24, 15, "#7FA7FF", true);
  text(s, "Recurring payments\nwithout surrendering\ncontrol.", 72, 160, 870, 216, 52, C.white, true);
  text(s, "Live demo", 72, 458, 160, 22, 12, "#7FA7FF", true);
  text(s, "paymap-web.vercel.app", 72, 488, 500, 34, 22, C.white, true);
  text(s, "Repository", 684, 458, 160, 22, 12, "#7FA7FF", true);
  text(s, "github.com/SachPlayZ/Paymap", 684, 488, 500, 34, 22, C.white, true);
  shape(s, "rect", 72, 618, 1136, 2, "#31343C");
  text(s, "Built on Stellar · Testnet evidence linked in README", 72, 644, 600, 22, 13, "#AFB5C1");
  notes(s, "End with the live product. Then run the demo flow from the walkthrough script.", [
    "https://paymap-web.vercel.app",
    "https://github.com/SachPlayZ/Paymap",
  ]);
}

await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(PREVIEW, { recursive: true });

for (const [i, slide] of deck.slides.items.entries()) {
  const png = await deck.export({ slide, format: "png", scale: 1 });
  await fs.writeFile(`${PREVIEW}/slide-${String(i + 1).padStart(2, "0")}.png`, new Uint8Array(await png.arrayBuffer()));
  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(`${PREVIEW}/slide-${String(i + 1).padStart(2, "0")}.layout.json`, await layout.text());
}

const montage = await deck.export({ format: "webp", montage: true, scale: 1 });
await fs.writeFile(`${PREVIEW}/montage.webp`, new Uint8Array(await montage.arrayBuffer()));
const pptx = await PresentationFile.exportPptx(deck);
await pptx.save(`${OUT}/Paymap-Level-5-Pitch-Deck.pptx`);
