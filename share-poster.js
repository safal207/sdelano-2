"use strict";

// Build a private, per-user JPG in the browser. Never reads or draws task names.
window.achievementPoster = (() => {
  const WIDTH = 1200;
  const HEIGHT = 630;

  function fillRounded(ctx, x, y, width, height, radius, color) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  function fitText(ctx, text, x, baseline, maxWidth, fontSize, color) {
    let size = fontSize;
    do {
      ctx.font = "900 " + size + "px Arial, sans-serif";
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 2;
    } while (size > 38);
    ctx.fillStyle = color;
    ctx.fillText(text, x, baseline, maxWidth);
  }

  async function create({ done, total } = {}) {
    if (!Number.isInteger(done) || !Number.isInteger(total) ||
        total < 1 || total > 9999 || done < 0 || done > total) {
      throw new RangeError("Invalid achievement counts");
    }
    const percent = Math.floor(done * 100 / total);
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable");

    // Use the approved local mascot; the caller retains the existing static
    // poster/link fallback if the image cannot be decoded.
    const fox = new Image();
    fox.src = new URL("assets/fox-mascot.webp", document.baseURI).href;
    await fox.decode();
    if (!fox.naturalWidth || !fox.naturalHeight) throw new Error("Mascot unavailable");

    ctx.fillStyle = "#fff4df";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    fillRounded(ctx, 32, 32, 1136, 566, 34, "#fffdf5");
    fillRounded(ctx, 55, 54, 1090, 86, 18, "#ffe0a8");
    ctx.fillStyle = "#422618";
    ctx.font = "900 50px Arial, sans-serif";
    ctx.fillText("СДЕЛАНО.", 82, 114);

    // Counts describe the current list, never a lifetime achievement or XP.
    const headline = done === 0 ? "НАЧНИ С ОДНОГО ДЕЛА" :
      done === 1 ? "ОДНО ДЕЛО ГОТОВО!" :
      done === 3 ? "ТРИ ДЕЛА ГОТОВЫ!" : "ДЕЛА СДЕЛАНЫ!";
    fitText(ctx, headline, 78, 204, 510, 52, "#422618");
    fitText(ctx, String(done), 70, 371, 490, 170, "#422618");
    fitText(ctx, "ИЗ " + total + " ЗАДАЧ", 82, 423, 485, 44, "#69412c");

    fillRounded(ctx, 615, 160, 506, 276, 28, done > 0 ? "#e5f3bd" : "#ffedc4");
    const scale = Math.min(208 / fox.naturalWidth, 208 / fox.naturalHeight);
    const w = fox.naturalWidth * scale, h = fox.naturalHeight * scale;
    ctx.drawImage(fox, 868 - w / 2, 173 + (208 - h) / 2, w, h);
    ctx.textAlign = "center";
    fitText(ctx, percent + "%", 868, 420, 430, 50, "#395321");
    ctx.textAlign = "left";

    fillRounded(ctx, 79, 454, 1042, 16, 8, "#dfd5c5");
    if (percent > 0) fillRounded(ctx, 79, 454, 1042 * percent / 100, 16, 8, "#527539");

    // Keep the CTA clear of the timestamp overlay at bottom right.
    fillRounded(ctx, 79, 490, 1042, 83, 18, "#ffc849");
    fitText(ctx, "ЗАПИШИ ЗАДАЧУ", 103, 546, 730, 53, "#422618");

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob || blob.type !== "image/jpeg") {
          reject(new Error("Could not create JPEG"));
          return;
        }
        resolve(new File([blob], "sdelano-progress-" + done + "-of-" + total + ".jpg",
          { type: "image/jpeg" }));
      }, "image/jpeg", 0.9);
    });
  }

  return Object.freeze({ create });
})();
