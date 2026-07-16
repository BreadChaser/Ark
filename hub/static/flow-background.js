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

  const number = (name, fallback) => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || fallback;

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

  function draw(now) {
    frame = requestAnimationFrame(draw);
    if (document.hidden || !opacity || now - previous < (mobile.matches ? 50 : 33)) return;
    const elapsed = Math.min(2, previous ? (now - previous) / 16.667 : 1);
    previous = now;
    const time = now / 1000;
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
    canvas.hidden = !opacity || !colors.length;
    context.clearRect(0, 0, canvas.width, canvas.height);
    previous = 0;
    if (!canvas.hidden) {
      resize();
      frame = requestAnimationFrame(draw);
    }
  }

  window.addEventListener("resize", refresh, { passive: true });
  window.addEventListener("ark-theme", refresh);
  document.addEventListener("visibilitychange", () => { previous = 0; });
  reducedMotion.addEventListener("change", refresh);
  refresh();
})();
