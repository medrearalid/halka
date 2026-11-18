// GPU voice orbs: every orb on a stage is one instanced quad in a single draw call.
// Each orb is three hairline rings of light whose radius wanders with smooth, per-person
// noise; speaking pulls the rings apart, widens them and sheds faint sparks.

const VS = `#version 300 es
layout(location=0) in vec2 q;
layout(location=1) in vec4 geo;   // cx, cy, radius, half-extent (device px)
layout(location=2) in vec3 col;
layout(location=3) in vec3 k;     // level, seed, kind (0 live, 1 silent, 2 ambient)
uniform vec2 size;
out vec2 p;
flat out float r;
flat out vec3 c;
flat out vec3 kk;
void main() {
  p = q * geo.w;
  r = geo.z;
  c = col;
  kk = k;
  vec2 pos = (geo.xy + p) / size * 2.0 - 1.0;
  gl_Position = vec4(pos.x, -pos.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 p;
flat in float r;
flat in vec3 c;
flat in vec3 kk;
uniform float t;
uniform float px;
out vec4 o;
const float TAU = 6.2831853;
vec3 hue(vec3 rgb, float a) {
  const mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 y = toYiq * rgb;
  float h = atan(y.z, y.y) + a;
  float ch = length(y.yz);
  return clamp(toRgb * vec3(y.x, ch * cos(h), ch * sin(h)), 0.0, 1.0);
}
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float d = length(p);
  if (kk.z > 1.5) {
    // ambient: the room takes a breath of the loudest speaker's colour
    float a = exp(-d * d / (r * r * 0.32)) * kk.x;
    o = vec4(c * a, a);
    return;
  }
  float silent = kk.z;
  float L = kk.x * (1.0 - silent);
  float ang = atan(p.y, p.x);
  float tt = t * (0.32 + L * 1.25);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float f = float(i) - 1.0;                      // -1, 0, 1
    float s = kk.y * TAU + float(i) * 2.17;
    // low harmonics only: the ring breathes and leans, it never jitters
    float n = 0.55 * sin(2.0 * ang + tt * 0.8 + s)
            + 0.3 * sin(3.0 * ang - tt * 1.1 + s * 1.7)
            + 0.15 * sin(5.0 * ang + tt * 1.6 + s * 2.3);
    float rk = r * (1.05 + L * (0.09 + 0.08 * f)) + n * r * (0.006 + L * 0.04);
    float w = px * (0.5 + L * 0.25);
    float x = d - rk;
    float line = exp(-x * x / (2.0 * w * w));
    float glow = exp(-abs(x) / (r * (0.025 + L * 0.035))) * 0.1;
    float bright = (silent > 0.5 ? 0.22 : 0.42 + L * 0.65) * (i == 1 ? 1.0 : 0.55);
    float sheen = 0.55 + 0.45 * cos(ang - tt * 0.3 - s);
    // the middle ring runs pale (a white-hot core); the outer two carry the hue shift
    vec3 tint = mix(hue(c, f * 0.5 + n * 0.2), vec3(1.0), i == 1 ? 0.35 : 0.0);
    acc += tint * (line + glow) * bright * sheen;
  }
  if (L > 0.02) {
    // sparks drift outward from the rim and fade: speech disperses the ring
    float cells = 72.0;
    float ci = floor((ang / TAU + 0.5) * cells);
    float rnd = hash(ci + kk.y * 97.0);
    float life = fract(t * (0.3 + rnd * 0.45) + rnd);
    float pa = (ci + 0.5) / cells * TAU - 3.14159265;
    vec2 pp = vec2(cos(pa), sin(pa)) * r * (1.07 + life * (0.18 + L * 0.32));
    float pd = length(p - pp);
    acc += c * exp(-pd * pd / (1.2 * px * px)) * (1.0 - life) * step(0.78, rnd) * L * 0.7;
  }
  float a = clamp(max(acc.r, max(acc.g, acc.b)), 0.0, 1.0);
  o = vec4(min(acc, vec3(a)), a);
}`;

export type OrbDraw = {
  x: number; // centre, device px from canvas top-left
  y: number;
  r: number; // avatar radius, device px
  rgb: readonly [number, number, number];
  level: number;
  seed: number;
  silent: boolean;
};

const STRIDE = 10; // geo(4) col(3) k(3)
const MAX = 33; // 32 orbs + ambient

export type OrbRenderer = {
  draw(orbs: OrbDraw[], ambient: OrbDraw | null, time: number, w: number, h: number, dpr: number): void;
  dispose(): void;
};

function shader(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}

export function createOrbRenderer(canvas: HTMLCanvasElement): OrbRenderer | null {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl || gl.isContextLost()) return null;
  let prog: WebGLProgram;
  try {
    prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
  } catch (e) {
    console.warn("orb shader unavailable", e);
    return null;
  }
  const uSize = gl.getUniformLocation(prog, "size");
  const uT = gl.getUniformLocation(prog, "t");
  const uPx = gl.getUniformLocation(prog, "px");
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const inst = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  gl.bufferData(gl.ARRAY_BUFFER, MAX * STRIDE * 4, gl.DYNAMIC_DRAW);
  const attr = (loc: number, n: number, off: number) => {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, n, gl.FLOAT, false, STRIDE * 4, off * 4);
    gl.vertexAttribDivisor(loc, 1);
  };
  attr(1, 4, 0);
  attr(2, 3, 4);
  attr(3, 3, 7);
  gl.bindVertexArray(null);
  const data = new Float32Array(MAX * STRIDE);

  const put = (i: number, o: OrbDraw, extent: number, kind: number) => {
    const b = i * STRIDE;
    data[b] = o.x;
    data[b + 1] = o.y;
    data[b + 2] = o.r;
    data[b + 3] = extent;
    data[b + 4] = o.rgb[0];
    data[b + 5] = o.rgb[1];
    data[b + 6] = o.rgb[2];
    data[b + 7] = o.level;
    data[b + 8] = o.seed;
    data[b + 9] = kind;
  };

  return {
    draw(orbs, ambient, time, w, h, dpr) {
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      let n = 0;
      if (ambient && ambient.level > 0.002) put(n++, ambient, ambient.r, 2);
      for (const o of orbs) {
        if (n >= MAX) break;
        put(n++, o, o.r * 1.75, o.silent ? 1 : 0);
      }
      if (!n) return;
      gl.useProgram(prog);
      gl.uniform2f(uSize, w, h);
      gl.uniform1f(uT, time);
      gl.uniform1f(uPx, dpr);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * STRIDE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.bindVertexArray(null);
    },
    dispose() {
      // Free our objects but keep the context: the same canvas may be set up again (StrictMode, remounts).
      gl.deleteBuffer(quad);
      gl.deleteBuffer(inst);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
  };
}
