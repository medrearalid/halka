import { useEffect, useRef } from "react";
import portraits from "./welcome-people.webp";

// Bust portraits in the 4x4 atlas (row-major cells). Row 3 holds full-body figures at a different
// scale, so they stay out of the crowd to keep it even.
const busts = [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15];

const columns = 12;
const rows = 16;
const period = 18; // seconds per loop; every motion below repeats a whole number of times in it
const tau = Math.PI * 2;
const stride = 8; // floats per figure

// Only the drawing's geometry moves (a soft head sway, a nod while talking, breathing shoulders);
// the inked face itself is never warped, so mouths and eyes keep their lines.
const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 placement; // center x, baseline y, height, facing (1 | -1)
layout(location=1) in vec4 style;     // atlas cell, phase, turn (0 | 1), opacity
uniform vec2 viewport;
uniform float cycle;
out vec2 local;
flat out vec2 cell;
flat out float opacity;
const float tau = 6.283185307;
void main() {
  vec2 p = vec2(gl_VertexID % ${columns + 1}, gl_VertexID / ${columns + 1}) / vec2(${columns}.0, ${rows}.0);
  local = p;
  cell = vec2(mod(style.x, 4.), floor(style.x / 4.));
  opacity = style.w;
  float t = cycle * tau, phase = style.y;
  // partners take turns: one talks (livelier head) while the other listens
  float talk = smoothstep(-.35, .35, sin(2. * t + phase * .2 + style.z * 3.14159265));
  float head = 1. - smoothstep(.40, .64, p.y);
  float upper = 1. - smoothstep(.52, 1., p.y);
  vec2 body = p;
  body.y -= upper * .006 * (.5 + .5 * sin(3. * t + phase));                   // breathing
  float angle = .018 * sin(t + phase) + talk * (.016 * sin(7. * t + phase));  // sway + talking tilt
  body.y += head * talk * .005 * (.5 + .5 * sin(11. * t + phase));            // small nods
  vec2 neck = vec2(.55, .58);
  float a = head * angle;
  body = neck + mat2(cos(a), sin(a), -sin(a), cos(a)) * (body - neck);
  vec2 pixel = placement.xy + vec2((body.x - .5) * .75 * placement.w, body.y - 1.) * placement.z;
  gl_Position = vec4(pixel / viewport * vec2(2., -2.) + vec2(-1., 1.), 0., 1.);
}`;

const fragment = `#version 300 es
precision highp float;
in vec2 local;
flat in vec2 cell;
flat in float opacity;
uniform sampler2D atlas;
out vec4 color;
void main() {
  color = texture(atlas, (cell + clamp(local, .002, .998)) / 4.) * opacity;
}`;

function shuffled() {
  const order = [...busts];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { order, phases: order.map(() => Math.random() * tau) };
}

/** Two evenly spaced rows; neighbours face each other in pairs. Back row first so the front draws over it. */
export function layout(width: number, height: number, cast: { order: number[]; phases: number[] }) {
  // sized so the back row's heads stay inside the canvas: top = height - .30f - .78f = .11 * height
  const front = height * 0.82;
  const back = front * 0.78;
  const rowsSpec = [
    { size: back, baseline: height - front * 0.3, opacity: 0.55, offset: 0.5 },
    { size: front, baseline: height + front * 0.02, opacity: 1, offset: 0 },
  ];
  const figures: number[][] = [];
  for (const row of rowsSpec) {
    const pitch = row.size * 0.75 * 0.86; // a bust is .75 of its height wide; overlap the shoulders a little
    // edge figures sit half off screen on both sides; the back row fills the gaps between them
    const step = width / Math.max(1, Math.ceil(width / pitch));
    const count = Math.round(width / step) + (row.offset ? 0 : 1);
    for (let i = 0; i < count; i++) {
      const facing = i % 2 === 0 ? 1 : -1;
      // pull pair partners a touch closer, so the gaps fall between conversations
      const x = (i + row.offset) * step + (facing === 1 ? 0.06 : -0.06) * step;
      figures.push([x, row.baseline, row.size, facing, 0, 0, facing === 1 ? 0 : 1, row.opacity]);
    }
  }
  // hand out drawings left to right across both rows, so a repeat (wide screens) is a dozen figures away
  [...figures].sort((a, b) => a[0] - b[0]).forEach((f, k) => {
    const slot = k % cast.order.length;
    f[4] = cast.order[slot];
    f[5] = cast.phases[slot];
  });
  return new Float32Array(figures.flat());
}

export function WelcomeCrowd() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current!;
    const gl = node.getContext("webgl2", { alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const cast = shuffled();
    const picture = new Image();
    let frame = 0, elapsed = 0, previous = 0, count = 0;
    let program: WebGLProgram | null = null, buffer: WebGLBuffer | null = null, texture: WebGLTexture | null = null;
    let time: WebGLUniformLocation | null = null;
    let mesh: WebGLBuffer | null = null;

    function stop() {
      cancelAnimationFrame(frame);
      frame = previous = 0;
    }
    function draw(now: number) {
      frame = 0;
      if (document.hidden || !program || !count) return;
      // cap the step so a long pause (hidden window) resumes smoothly instead of jumping
      if (previous && !motion.matches) elapsed += Math.min(now - previous, 100) / 1000;
      previous = now;
      gl!.uniform1f(time, motion.matches ? 0 : (elapsed % period) / period);
      gl!.clear(gl!.COLOR_BUFFER_BIT);
      gl!.drawElementsInstanced(gl!.TRIANGLES, columns * rows * 6, gl!.UNSIGNED_SHORT, 0, count);
      if (node.dataset.ready !== "true") node.dataset.ready = "true";
      if (!motion.matches) frame = requestAnimationFrame(draw);
    }
    function wake() {
      stop();
      if (!document.hidden && program && count) frame = requestAnimationFrame(draw);
    }
    function resize() {
      const width = node.clientWidth, height = node.clientHeight;
      if (!program || !width || !height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      node.width = Math.round(width * dpr);
      node.height = Math.round(height * dpr);
      gl!.viewport(0, 0, node.width, node.height);
      gl!.uniform2f(gl!.getUniformLocation(program, "viewport"), width, height);
      const data = layout(width, height, cast);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer);
      gl!.bufferData(gl!.ARRAY_BUFFER, data, gl!.STATIC_DRAW);
      count = data.length / stride;
      wake();
    }
    function release() {
      stop();
      gl!.deleteBuffer(buffer);
      gl!.deleteBuffer(mesh);
      gl!.deleteTexture(texture);
      gl!.deleteProgram(program);
      buffer = texture = program = null;
    }
    function init() {
      if (!picture.complete || !picture.naturalWidth || gl!.isContextLost()) return;
      program = gl!.createProgram();
      if (!program) return;
      for (const [type, source] of [[gl!.VERTEX_SHADER, vertex], [gl!.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl!.createShader(type)!;
        gl!.shaderSource(shader, source);
        gl!.compileShader(shader);
        gl!.attachShader(program, shader);
        gl!.deleteShader(shader);
      }
      gl!.linkProgram(program);
      if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) { release(); return; }
      gl!.useProgram(program);
      time = gl!.getUniformLocation(program, "cycle");
      const indices: number[] = [];
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
          const top = y * (columns + 1) + x;
          const bottom = top + columns + 1;
          indices.push(top, top + 1, bottom, bottom, top + 1, bottom + 1);
        }
      }
      mesh = gl!.createBuffer();
      gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, mesh);
      gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl!.STATIC_DRAW);
      buffer = gl!.createBuffer();
      gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer);
      for (let attr = 0; attr < 2; attr++) {
        gl!.enableVertexAttribArray(attr);
        gl!.vertexAttribPointer(attr, 4, gl!.FLOAT, false, stride * 4, attr * 16);
        gl!.vertexAttribDivisor(attr, 1);
      }
      texture = gl!.createTexture();
      gl!.bindTexture(gl!.TEXTURE_2D, texture);
      gl!.pixelStorei(gl!.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, picture);
      gl!.generateMipmap(gl!.TEXTURE_2D);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR_MIPMAP_LINEAR);
      gl!.enable(gl!.BLEND);
      gl!.blendFunc(gl!.ONE, gl!.ONE_MINUS_SRC_ALPHA);
      resize();
    }
    function lost(event: Event) {
      event.preventDefault();
      stop();
      program = null;
      node.dataset.ready = "false";
    }
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    node.addEventListener("webglcontextlost", lost);
    node.addEventListener("webglcontextrestored", init);
    document.addEventListener("visibilitychange", wake);
    motion.addEventListener("change", wake);
    picture.onload = init;
    picture.src = portraits;
    return () => {
      picture.onload = null;
      observer.disconnect();
      motion.removeEventListener("change", wake);
      document.removeEventListener("visibilitychange", wake);
      node.removeEventListener("webglcontextlost", lost);
      node.removeEventListener("webglcontextrestored", init);
      release();
    };
  }, []);
  return <div className="welcome-crowd"><canvas ref={canvas} /></div>;
}
