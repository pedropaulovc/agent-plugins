async page => {
  await page.waitForFunction(() => document.readyState !== "loading", { timeout: 15000 }).catch(() => { });
  await page.waitForTimeout(1500);

  const profileUrl = await page.url();
  const handleMatch = profileUrl.match(/\/(@[^/?#]+)/);
  const handle = handleMatch?.[1]?.slice(1).toLowerCase() ?? "";
  const pageText = ((await page.locator("body").innerText().catch(() => "")) || "").toLowerCase();
  const currentUrl = profileUrl.toLowerCase();
  const loginFormVisible = await page.locator('input[type="password"]').isVisible().catch(() => false);
  if (/(?:instagram|threads)\.com\/(?:[^/?#]+\/)*login/i.test(currentUrl) || loginFormVisible) {
    return { status: "login_required", profile: { handle, url: profileUrl }, posts: [], scrolls: 0, complete: false, stopReason: "login_required" };
  }
  if (/this profile is private|account is private|profile is private/.test(pageText)) {
    return { status: "private", profile: { handle, url: profileUrl }, posts: [], scrolls: 0, complete: false, stopReason: "private" };
  }
  if (/challenge_required|unusual activity|try again later|something went wrong/.test(pageText)) {
    return { status: "blocked", profile: { handle, url: profileUrl }, posts: [], scrolls: 0, complete: false, stopReason: "challenge_or_block" };
  }

  const posts = new Map();
  let stagnant = 0;
  let stopReason = "max_scrolls";
  let complete = false;
  let scrolls = 0;
  const maxScrolls = 240;

  const collect = async () => {
    const found = await page.evaluate((wantedHandle) => {
      const clean = value => (value || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
      const ownPost = href => {
        try {
          const url = new URL(href, location.href);
          const pieces = url.pathname.split("/").filter(Boolean);
          return pieces.length === 3 && pieces[0].toLowerCase() === `@${wantedHandle}` && pieces[1] === "post" ? pieces[2] : null;
        } catch {
          return null;
        }
      };
      const linesFor = node => [...new Set((node?.innerText || "").split(/\n+/).map(clean).filter(Boolean))];
      const posts = [];
      for (const link of document.querySelectorAll('a[href*="/post/"]')) {
        const id = ownPost(link.getAttribute("href"));
        if (!id) continue;
        const card = link.closest("article,[role='article'],[data-pressable-container='true']") || link.parentElement;
        const lines = linesFor(card);
        const time = card?.querySelector("time[datetime]");
        const media = [...(card?.querySelectorAll("img[src],video[src]") || [])]
          .map(node => ({ type: node.tagName.toLowerCase(), url: node.currentSrc || node.src || null, alt: node.alt || null }))
          .filter(item => item.url);
        const text = lines.filter(line => !/^@?[a-z0-9_.-]+$/i.test(line) && !/^follow$/i.test(line)).join("\n");
        posts.push({ id, url: new URL(`/@${wantedHandle}/post/${id}`, location.origin).href, text, createdAt: time?.dateTime || null, media });
      }
      return posts;
    }, handle);

    for (const post of found) {
      const existing = posts.get(post.id);
      if (!existing || post.text.length > existing.text.length || post.media.length > existing.media.length) posts.set(post.id, post);
    }
    return found.length;
  };

  for (; scrolls < maxScrolls; scrolls += 1) {
    const before = posts.size;
    const heightBefore = await page.evaluate(() => document.documentElement.scrollHeight);
    await collect();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(1400);
    const heightAfter = await page.evaluate(() => document.documentElement.scrollHeight);
    if (posts.size === before && heightAfter <= heightBefore) stagnant += 1;
    else stagnant = 0;
    const endText = ((await page.locator("body").innerText().catch(() => "")) || "").toLowerCase();
    if (/you've reached the end|no more posts|nothing else to show/.test(endText)) {
      stopReason = "explicit_end";
      complete = true;
      break;
    }
    if (stagnant >= 5) {
      stopReason = "no_progress";
      break;
    }
  }
  await collect();


  return {
    status: "ok",
    profile: { handle, url: profileUrl },
    posts: [...posts.values()],
    scrolls,
    complete,
    stopReason,
  };
}
