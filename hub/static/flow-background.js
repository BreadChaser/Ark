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
  }

  function angle(x, y, time) {
    const sx = x * 0.0042 * scale;
    const sy = y * 0.0037 * scale;
    return Math.sin(sx + time * 0.11) * 0.92
      + Math.cos(sy - time * 0.085) * 0.76
      + Math.sin((sx + sy) * 0.58 + time * 0.055) * 0.5;
  }

  function ridge(position) {
    const peak = (center, span, weight) => Math.max(0, 1 - Math.abs(position - center) / span) ** 1.6 * weight;
    return peak(0.24, 0.28, 0.86) + peak(0.57, 0.34, 1) + peak(0.84, 0.21, 0.46);
  }

  function drawContours() {
    context.clearRect(0, 0, width, height);
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = mobile.matches ? 0.75 : 1;
    context.shadowBlur = mobile.matches ? 0 : 5;
    const count = mobile.matches ? 6 : 8;
    const step = mobile.matches ? 15 : 12;
    for (let contour = 0; contour < count; contour += 1) {
      const baseline = height * (0.84 + contour * 0.027);
      const depth = height * (0.27 - contour * 0.018);
      context.beginPath();
      for (let x = 0; x <= width + step; x += step) {
        const position = x / width;
        const y = baseline - ridge(position) * depth + Math.sin(position * 26 + contour * 0.8) * 3;
        if (x === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.strokeStyle = contour % 3 === 1 ? sceneSecondary : scenePrimary;
      context.shadowColor = context.strokeStyle;
      context.globalAlpha = 0.15 - contour * 0.011;
      context.stroke();
    }
    context.restore();
  }

  function drawStars(time) {
    context.clearRect(0, 0, width, height);
    context.save();
    const count = mobile.matches ? 46 : 104;
    for (let index = 0; index < count; index += 1) {
      const x = random(index + 1) * width;
      const y = random(index + 101) * height;
      const phase = random(index + 211) * Math.PI * 2;
      const pulse = 0.5 + Math.sin(time * (0.55 + random(index + 307)) + phase) * 0.5;
      const radius = 0.35 + random(index + 401) * 0.9;
      context.fillStyle = index % 5 === 0 ? sceneSecondary : scenePrimary;
      context.globalAlpha = 0.12 + pulse * (0.24 + random(index + 503) * 0.24);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
      if (!mobile.matches && index % 23 === 0 && pulse > 0.65) {
        context.globalAlpha *= 0.6;
        context.strokeStyle = context.fillStyle;
        context.lineWidth = 0.6;
        context.beginPath();
        context.moveTo(x - 3, y);
        context.lineTo(x + 3, y);
        context.moveTo(x, y - 3);
        context.lineTo(x, y + 3);
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
      if (scene === "contours") drawContours();
      if (scene === "stars") drawStars(0);
      if (!reducedMotion.matches && (opacity || scene === "stars")) frame = requestAnimationFrame(draw);
    }
  }

  window.addEventListener("resize", refresh, { passive: true });
  window.addEventListener("ark-theme", refresh);
  document.addEventListener("visibilitychange", () => { previous = 0; });
  reducedMotion.addEventListener("change", refresh);
  refresh();
})();
