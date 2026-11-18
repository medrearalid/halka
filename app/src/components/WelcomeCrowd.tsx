import { useEffect, useRef } from "react";
import portraits from "./welcome-people.webp";

// In each portrait's own coordinates: lip center, half-width and resting aperture,
// near eye center, then the hand that leads its gesture.
const landmarks = [
  [.662,.389,.044,.005, .603,.299, .71,.69],
  [.707,.408,.052,.022, .631,.311, .77,.48],
  [.657,.365,.048,.011, .605,.261, .79,.76],
  [.755,.403,.041,.015, .674,.318, .81,.48],
  [.632,.353,.051,.020, .598,.248, .35,.61],
  [.637,.339,.044,.021, .568,.244, .77,.65],
  [.633,.358,.045,.005, .579,.239, .70,.49],
  [.661,.366,.050,.014, .621,.266, .83,.67],
  // Four full-body figures sit between the two portrait sets in the atlas.
  ...Array.from({ length: 4 }, () => [0,0,0,0,0,0,0,0]),
  [.515,.360,.055,.016, .445,.243, .800,.459],
  [.660,.327,.050,.022, .624,.211, .813,.676],
  [.698,.365,.062,.021, .609,.277, .671,.790],
  [.728,.390,.045,.005, .642,.286, .873,.496],
];

const columns = 18;
const rows = 24;
const period = 18;
const tau = Math.PI * 2;

const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 placement; // center x, baseline, height, facing
layout(location=1) in vec4 role;      // portrait, dialogue offset, partner, activity
layout(location=2) in vec4 lips;
layout(location=3) in vec4 features;  // near eye, hand
layout(location=4) in vec2 style;     // individual phase, depth
uniform vec2 viewport;
uniform float cycle;
out vec2 local;
flat out vec4 mouth;
flat out vec2 eye;
flat out vec4 face; // opening, widening, surprise, lid closure
flat out vec2 cell;
flat out float opacity;
const float tau = 6.283185307;
float region(vec2 p, vec2 center, vec2 radius) {
  vec2 offset = (p-center)/radius;
  return exp(-dot(offset,offset));
}
float event(float t, float a, float b, float attack, float release) {
  return smoothstep(a,a+attack,t)*(1.-smoothstep(b-release,b,t));
}
void main() {
  vec2 p = vec2(gl_VertexID % ${columns + 1}, gl_VertexID / ${columns + 1}) / vec2(${columns}.0,${rows}.0);
  local=p; mouth=lips; eye=features.xy;
  cell=vec2(mod(role.x,4.),floor(role.x/4.));
  float t=cycle*tau;
  float phase=style.x;
  vec2 center=placement.xy;
  vec2 body=p;
  float breath=sin(3.*t+phase);
  float tilt=breath*.008, lean=breath*.004;
  float head=1.-smoothstep(.34,.60,p.y);
  face=vec4(0.);
  if (role.w < .5) {
    // Partners share a score. Each hears the end of the other's phrase before reacting.
    float bar=fract(2.*cycle+role.y+role.z*.5);
    float phrase=event(bar,.018,.23,.025,.030)+event(bar,.264,.436,.018,.045);
    float voice=bar*(24.+mod(role.x,4.))+phase;
    float vowel=pow(.5+.5*sin(voice*tau+.62*sin(voice*2.1)),.84);
    float reaction=event(bar,.706,.960,.038,.083);
    bool laughs=role.x==1. || role.x==4. || role.x==5. || role.x==7.;
    float laugh=laughs ? reaction : 0.;
    float surprise=laughs ? 0. : reaction;
    float chuckle=.5+.5*sin(t*38.+phase);
    float blink=event(fract(cycle*4.+phase),.30,.331,.012,.014);
    face=vec4(phrase*vowel+laugh*(.32+.68*chuckle)+surprise*.72,
              laugh*.68+phrase*.29*sin(voice*3.1)-surprise*.50,
              surprise,max(blink,laugh*(.48+.42*chuckle)));
    float nod=event(bar,.57,.69,.043,.055);
    lean+=phrase*.026-surprise*.045-laugh*.025;
    tilt+=phrase*.034+nod*.087-surprise*.076-laugh*.048;
    body.y+=head*(.020*nod-.022*surprise)+laugh*.014*chuckle*(1.-p.y);
    body+=region(p,features.zw,vec2(.17,.14))*phrase*sin(t*8.+phase)*vec2(.025,-.035);
  } else if (role.w < 1.5) {
    // Hood up: shoulders breathe, head dips occasionally.
    head=1.-smoothstep(.29,.49,p.y);
    tilt+=.035*event(cycle,.26,.56,.11,.14);
    body.y+=.008*breath*(1.-p.y);
  } else if (role.w < 2.5) {
    float beat=t*32.;
    head=1.-smoothstep(.22,.40,p.y);
    tilt+=.059*sin(beat)+.016*sin(beat*.5);
    body.y-=region(p,vec2(.34,.86),vec2(.13,.12))*.035*(.5+.5*cos(beat));
    body.x+=head*.009*sin(beat);
  } else if (role.w < 3.5) {
    // The pencil hand follows short strokes, then pauses while the artist looks up.
    float look=event(cycle,.62,.82,.07,.09);
    body+=region(p,vec2(.48,.61),vec2(.16,.11))*(1.-look)*vec2(.020*sin(t*23.),.008*cos(t*41.));
    head=1.-smoothstep(.27,.47,p.y);
    tilt-=look*.08;
  } else {
    float stride=t*16.+phase;
    center.x=mix(-placement.z,viewport.x+placement.z,fract(cycle+role.y));
    float leg=smoothstep(.50,.95,p.y);
    body.x+=(.53-p.x)*leg*(.58-.58*cos(stride));
    body.y-=leg*.045*max(0.,sin(stride))*smoothstep(.52,.72,p.x);
    body.x+=region(p,vec2(.79,.49),vec2(.14,.17))*.061*sin(stride);
    center.y+=placement.z*.009*cos(2.*stride);
  }
  vec2 neck=vec2(.50,role.w<.5 ? .53 : .36);
  float angle=head*tilt;
  body=neck+mat2(cos(angle),sin(angle),-sin(angle),cos(angle))*(body-neck);
  body.x+=(1.-p.y)*lean;
  vec2 pixel=center+vec2((body.x-.5)*.75*placement.w,body.y-1.)*placement.z;
  gl_Position=vec4(pixel/viewport*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);
  opacity=style.y;
}`;

const fragment = `#version 300 es
precision highp float;
in vec2 local;
flat in vec4 mouth;
flat in vec2 eye;
flat in vec4 face;
flat in vec2 cell;
flat in float opacity;
uniform sampler2D atlas;
out vec4 color;
void main() {
  vec2 p=local;
  if (mouth.z>0.) {
    // Resample the actual inked lips, preserving their corners. Close the resting
    // aperture between syllables and show the original teeth as the jaw drops.
    float x=(p.x-mouth.x)/mouth.z;
    float y=p.y-mouth.y;
    float edge=1.-smoothstep(.65,1.30,abs(x));
    float nearLip=1.-smoothstep(.039,.090,abs(y));
    float rest=mouth.w;
    float target=.002+face.x*.024;
    float k=edge*nearLip;
    float d=target-rest;
    float upper=-rest-.35*d, lower=rest+1.65*d;
    float sy=y<upper ? y+.35*d : y>lower ? y-1.65*d : mix(-rest,rest,(y-upper)/(lower-upper));
    p.y+=k*(sy-y+.009*face.y*x*x);
    p.x-=k*(p.x-mouth.x)*face.y*.36;
    // Eyebrow lift, eye widening and smiling lids follow the same reaction.
    vec2 e=p-eye;
    float across=1.-smoothstep(.038,.090,abs(e.x));
    float lift=exp(-pow((e.y+.033)/.026,2.));
    p.y+=across*lift*face.z*.025;
    float eyelid=1.-smoothstep(.012,.036,abs(e.y));
    p.y+=across*eyelid*e.y*(face.w*3.4-face.z*.42);
  }
  vec2 uv=(cell+clamp(p,.002,.998))/vec2(4.,4.);
  color=texture(atlas,uv)*opacity;
}`;

function makeCast() {
  const portraits = [0,1,2,3,4,5,6,7,12,13,14,15];
  for (let i = portraits.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [portraits[i], portraits[j]] = [portraits[j], portraits[i]];
  }
  return { portraits, cues: portraits.map(() => Math.random()), phases: landmarks.map(() => Math.random()*tau) };
}

function actors(width: number, height: number, cast: ReturnType<typeof makeCast>) {
  const data: number[] = [];
  const compact = width / height < 3.1 || width < 620;
  const unit = Math.min(height, width / (compact ? 2.25 : 4.3));
  function place(id: number, x: number, baseline: number, scale: number, facing: number,
    activity: number, cue: number, partner: number, opacity: number) {
    const points = landmarks[id] ?? [0,0,0,0,0,0,0,0];
    data.push(width*x, height-(1-baseline)*unit, scale*unit, facing,
      id, cue, partner, activity, ...points, cast.phases[id], opacity);
  }
  function pair(slot: number, x: number, baseline: number, scale: number, opacity: number) {
    const left = cast.portraits[slot*2], right = cast.portraits[slot*2+1];
    const cue = cast.cues[slot];
    const gap=scale*unit*.30/width;
    place(left,x-gap,baseline,scale,1,0,cue,0,opacity);
    place(right,x+gap,baseline,scale*.96,-1,0,cue,1,opacity);
  }
  if (!compact) {
    place(10,0,.72,.50,1,4,cast.cues[6],0,.61);
    pair(4,.108,.85,.72,.66);
    pair(5,.866,.87,.76,.70);
    pair(2,.22,1.02,.64,.83);
    place(11,.375,.83,.52,1,3,0,0,.84);
    pair(3,.62,1.02,.73,.89);
    pair(1,.445,1.17,.80,.98);
  } else {
    pair(1,.36,.90,.69,.72);
  }
  place(8,compact?.12:.075,1,.72,1,1,0,0,.95);
  place(9,compact?.87:.928,.99,.78,1,2,0,0,.98);
  pair(0,compact?.50:.755,1.16,.90,1);
  return new Float32Array(data);
}

export function WelcomeCrowd() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current!;
    const gl = node.getContext("webgl2", { alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const cast = makeCast();
    const picture = new Image();
    let frame = 0, elapsed = 0, previous = 0, count = 0;
    let width = 0, height = 0;
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
      if (previous && !motion.matches) elapsed += (now - previous) / 1000;
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
      width = node.clientWidth;
      height = node.clientHeight;
      if (!program || !width || !height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      node.width = Math.round(width * dpr);
      node.height = Math.round(height * dpr);
      gl!.viewport(0, 0, node.width, node.height);
      gl!.uniform2f(gl!.getUniformLocation(program, "viewport"), width, height);
      const data = actors(width, height, cast);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, buffer);
      gl!.bufferData(gl!.ARRAY_BUFFER, data, gl!.STATIC_DRAW);
      count = data.length / 18;
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
      for (let attr = 0; attr < 5; attr++) {
        gl!.enableVertexAttribArray(attr);
        gl!.vertexAttribPointer(attr, attr === 4 ? 2 : 4, gl!.FLOAT, false, 72, attr * 16);
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
