(() => {
  const canvas = document.querySelector(".background-flow");
  const context = canvas?.getContext("2d", { alpha: true });
  if (!canvas || !context) return;

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const mobile = matchMedia("(max-width: 760px)");
  let frame = 0;
  let previous = 0;
  let width = 0;
  let height = 0;
  let density = 1;
  let scale = 1;
  let speed = 1;
  let opacity = 0;
  let colors = [];
  let particles = [];
  let contourTrails = [];
  let scene = "none";
  let scenePrimary = "#ffffff";
  let sceneSecondary = "#ffffff";

  const number = (name, fallback) => {
    const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  };

  const random = (seed) => {
    const value = Math.sin(seed * 12.9898) * 43758.5453;
    return value - Math.floor(value);
  };

  function seed() {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      age: 0,
      life: 380 + Math.random() * 560,
      color: Math.floor(Math.random() * colors.length),
    };
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, mobile.matches ? 1 : 1.5);
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = mobile.matches ? 46 : Math.max(108, Math.min(152, Math.round(width * height / 15000)));
    particles = Array.from({ length: Math.round(count * density) }, seed);
    const trailCount = mobile.matches ? 5 : 9;
    contourTrails = Array.from({ length: trailCount }, (_, index) => seedContourTrail(index, trailCount));
  }

  function angle(x, y, time) {
    const sx = x * 0.0042 * scale;
    const sy = y * 0.0037 * scale;
    return Math.sin(sx + time * 0.11) * 0.92
      + Math.cos(sy - time * 0.085) * 0.76
      + Math.sin((sx + sy) * 0.58 + time * 0.055) * 0.5;
  }

  function seedContourTrail(index, count) {
    return {
      level: count > 1 ? index / (count - 1) : 0.5,
      scanOffset: Math.random(),
      scanSpeed: 0.31 + Math.random() * 0.12,
      phase: Math.random() * Math.PI * 2,
    };
  }

  function ridge(position, trail, time) {
    const peak = (center, span, weight) => Math.max(0, 1 - Math.abs(position - center) / span) * weight;
    const shape = Math.floor(time * 0.38) * 31;
    const mountain = (offset, start, span) => peak(
      start + random(shape + offset) * span,
      0.04 + random(shape + offset + 0.5) * 0.11,
      0.3 + random(shape + offset + 1) * 0.72,
    );
    const detail = Math.sin(position * 31 + trail.phase) * 0.018 + Math.sin(position * 63 - trail.phase) * 0.008;
    return mountain(1, 0.08, 0.16) + mountain(3, 0.28, 0.18)
      + mountain(5, 0.48, 0.17) + mountain(7, 0.7, 0.18) + detail;
  }

  function drawContours(time) {
    context.save();
    context.globalCompositeOperation = "destination-out";
    context.globalAlpha = mobile.matches ? 0.045 : 0.035;
    context.fillRect(0, 0, width, height);
    context.restore();
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = mobile.matches ? 0.7 : 0.9;
    context.shadowBlur = mobile.matches ? 0 : 5;
    const step = mobile.matches ? 10 : 7;
    for (const trail of contourTrails) {
      const head = ((time * trail.scanSpeed + trail.scanOffset) % 1) * width;
      const tail = Math.max(0, head - width * 0.19);
      const baseline = height * (0.68 + trail.level * 0.24);
      const depth = height * (0.23 - trail.level * 0.1);
      context.beginPath();
      for (let x = tail; x <= head + step; x += step) {
        const position = x / width;
        const texture = Math.sin(position * 18 + trail.phase) * (2.1 + trail.level * 2)
          + Math.sin(position * 49 - trail.phase) * 1.35;
        const y = baseline - ridge(position, trail, time) * depth + texture;
        if (x === tail) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.strokeStyle = trail.level > 0.64 ? sceneSecondary : scenePrimary;
      context.shadowColor = context.strokeStyle;
      context.globalAlpha = 0.2 - trail.level * 0.07;
      context.stroke();
    }

    const stars = mobile.matches ? 7 : 18;
    for (let index = 0; index < stars; index += 1) {
      const x = random(index + 811) * width;
      const y = (0.06 + random(index + 907) * 0.43) * height;
      const pulse = Math.max(0, Math.sin(time * (0.8 + random(index + 1009)) + random(index + 1103) * Math.PI * 2));
      const bright = index % 6 === 0 && pulse > 0.74;
      context.fillStyle = index % 4 === 0 ? sceneSecondary : scenePrimary;
      context.globalAlpha = 0.02 + pulse * 0.045;
      context.beginPath();
      context.arc(x, y, bright ? 1.25 : 0.72, 0, Math.PI * 2);
      context.fill();
      if (bright) {
        context.globalAlpha *= 0.72;
        context.strokeStyle = context.fillStyle;
        context.lineWidth = 0.65;
        context.beginPath();
        context.moveTo(x - 3.5, y);
        context.lineTo(x + 3.5, y);
        context.moveTo(x, y - 3.5);
        context.lineTo(x, y + 3.5);
        context.stroke();
      }
    }

    context.restore();
  }

  function drawStars(time) {
    context.clearRect(0, 0, width, height);
    context.save();
    const count = mobile.matches
      ? Math.max(128, Math.min(180, Math.round(width * height / 2500)))
      : Math.max(320, Math.min(520, Math.round(width * height / 3400)));
    for (let index = 0; index < count; index += 1) {
      const x = random(index + 1) * width;
      const y = random(index + 101) * height;
      const phase = random(index + 211) * Math.PI * 2;
      const pulse = 0.5 + Math.sin(time * (0.55 + random(index + 307)) + phase) * 0.5;
      const brilliance = random(index + 503);
      const radius = 0.62 + brilliance * brilliance * 1.32;
      context.fillStyle = index % 7 === 0 ? sceneSecondary : scenePrimary;
      context.globalAlpha = 0.34 + pulse * (0.29 + brilliance * 0.22);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      if (!mobile.matches && index % 29 === 0) {
        const twinkle = Math.max(0, Math.sin(time * (1.2 + brilliance) + phase)) ** 6;
        if (twinkle < 0.08) continue;
        context.globalAlpha *= twinkle;
        context.strokeStyle = context.fillStyle;
        context.lineWidth = 0.7;
        context.beginPath();
        context.moveTo(x - 3 - twinkle * 4, y);
        context.lineTo(x + 3 + twinkle * 4, y);
        context.moveTo(x, y - 3 - twinkle * 4);
        context.lineTo(x, y + 3 + twinkle * 4);
        context.stroke();
      }
    }
    const streak = (time % 18) / 18;
    if (!mobile.matches && streak < 0.1) {
      const progress = streak / 0.1;
      context.globalAlpha = 0.32 * (1 - progress);
      context.strokeStyle = sceneSecondary;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(width * (0.18 + progress * 0.42), height * (0.28 + progress * 0.16));
      context.lineTo(width * (0.12 + progress * 0.42), height * (0.24 + progress * 0.16));
      context.stroke();
    }
    context.restore();
  }

  function draw(now) {
    frame = requestAnimationFrame(draw);
    if (document.hidden || now - previous < (mobile.matches ? 50 : 33)) return;
    const elapsed = Math.min(2, previous ? (now - previous) / 16.667 : 1);
    previous = now;
    const time = now / 1000;
    if (scene === "contours") {
      drawContours(time);
      return;
    }
    if (scene === "stars") {
      drawStars(time);
      return;
    }
    if (!opacity) return;
    context.save();
    context.globalCompositeOperation = "destination-out";
    context.globalAlpha = 0.012;
    context.fillRect(0, 0, width, height);
    context.restore();
    context.lineCap = "round";
    context.lineWidth = mobile.matches ? 0.8 : 1.05;
    for (const particle of particles) {
      const lastX = particle.x;
      const lastY = particle.y;
      const direction = angle(lastX, lastY, time);
      const distance = (1.05 + Math.sin(particle.age * 0.017) * 0.18) * speed * elapsed;
      particle.x += Math.cos(direction) * distance;
      particle.y += Math.sin(direction) * distance;
      particle.age += elapsed;
      if (particle.age > particle.life || particle.x < -30 || particle.x > width + 30 || particle.y < -30 || particle.y > height + 30) Object.assign(particle, seed());
      context.beginPath();
      context.moveTo(lastX, lastY);
      context.lineTo(particle.x, particle.y);
      context.strokeStyle = colors[particle.color] || colors[0];
      context.shadowBlur = mobile.matches ? 0 : 3;
      context.shadowColor = context.strokeStyle;
      context.globalAlpha = opacity * Math.min(1, particle.age / 55);
      context.stroke();
    }
    context.shadowBlur = 0;
    context.globalAlpha = 1;
  }

  function refresh() {
    cancelAnimationFrame(frame);
    const style = getComputedStyle(document.documentElement);
    opacity = reducedMotion.matches ? 0 : Math.max(0, Math.min(1, number("--flow-opacity", 0)));
    colors = style.getPropertyValue("--flow-colors").split(",").map((color) => color.trim()).filter(Boolean);
    density = number("--flow-density", 1);
    scale = number("--flow-scale", 1);
    speed = number("--flow-speed", 1);
    scene = style.getPropertyValue("--flow-scene").trim() || "none";
    scenePrimary = style.getPropertyValue("--scene-primary").trim() || "#ffffff";
    sceneSecondary = style.getPropertyValue("--scene-secondary").trim() || scenePrimary;
    canvas.hidden = (!opacity || !colors.length) && scene === "none";
    context.clearRect(0, 0, canvas.width, canvas.height);
    previous = 0;
    if (!canvas.hidden) {
      resize();
      if (scene === "contours") drawContours(0);
      if (scene === "stars") drawStars(0);
      if (!reducedMotion.matches && (opacity || scene === "contours" || scene === "stars")) frame = requestAnimationFrame(draw);
    }
  }

  window.addEventListener("resize", refresh, { passive: true });
  window.addEventListener("ark-theme", refresh);
  document.addEventListener("visibilitychange", () => { previous = 0; });
  reducedMotion.addEventListener("change", refresh);
  refresh();
})();
