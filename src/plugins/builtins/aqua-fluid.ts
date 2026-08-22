/**
 * WebGL2 two-pass Aqua fluid backdrop.
 *
 * The shader recipe is adapted from DSH-Transparent-UI-Plugin's MIT-licensed
 * fluid renderer (Copyright 2026 John Wu). Host lifecycle, resizing, palette
 * updates and resource disposal are implemented for AI Image Manager.
 */

export interface AquaFluidOptions {
  dark: boolean;
  depth: number;
  hue: number;
  reducedMotion: boolean;
}

export interface AquaFluidHandle {
  dispose: () => void;
  setOptions: (options: AquaFluidOptions) => void;
}

interface FlowTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
}

const VERTEX_SHADER = `#version 300 es
in vec4 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position.xy * 0.5 + 0.5;
  gl_Position = a_position;
}
`;

const FLOW_SHADER = `#version 300 es
precision mediump float;

in vec2 v_uv;
out vec4 out_color;

uniform sampler2D u_previous;
uniform vec2 u_pointer;
uniform vec2 u_velocity;
uniform float u_brush_radius;
uniform float u_brush_strength;
uniform float u_decay;

void main() {
  vec4 previous = texture(u_previous, v_uv);
  previous.r *= u_decay;
  previous.gb = mix(vec2(0.5), previous.gb, u_decay);

  float distance_to_pointer = distance(v_uv, u_pointer);
  float influence = exp(
    -distance_to_pointer * distance_to_pointer /
    (u_brush_radius * u_brush_radius * 0.5)
  );
  influence = max(0.0, influence - 0.01);

  float speed = length(u_velocity);
  float presence = u_brush_strength * 0.3;
  float velocity_bonus = min(speed * 3.0, 0.7) * u_brush_strength;
  float strength = presence + velocity_bonus;
  previous.r = max(previous.r, influence * strength);
  float blend = influence * min(strength, 0.4) * 0.3;
  previous.g = mix(
    previous.g,
    clamp(u_velocity.x * 2.0 + 0.5, 0.0, 1.0),
    blend
  );
  previous.b = mix(
    previous.b,
    clamp(u_velocity.y * 2.0 + 0.5, 0.0, 1.0),
    blend
  );
  out_color = previous;
}
`;

const DISPLAY_SHADER = `#version 300 es
precision mediump float;

in vec2 v_uv;
out vec4 out_color;

uniform float u_time;
uniform float u_pixel_ratio;
uniform vec2 u_resolution;
uniform float u_scale;
uniform float u_rotation;
uniform vec4 u_color_1;
uniform vec4 u_color_2;
uniform vec4 u_color_3;
uniform float u_proportion;
uniform float u_softness;
uniform float u_shape_scale;
uniform float u_distortion;
uniform float u_swirl;
uniform float u_swirl_iterations;
uniform vec2 u_offset;
uniform sampler2D u_flow_map;
uniform float u_distort_boost;
uniform float u_noise_boost;
uniform float u_swirl_boost;

#define TWO_PI 6.28318530718
#define PI 3.14159265358979323846

vec2 rotate_point(vec2 point, float angle) {
  return mat2(cos(angle), sin(angle), -sin(angle), cos(angle)) * point;
}

float random_value(vec2 point) {
  return fract(sin(dot(point.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  float a = random_value(cell);
  float b = random_value(cell + vec2(1.0, 0.0));
  float c = random_value(cell + vec2(0.0, 1.0));
  float d = random_value(cell + vec2(1.0, 1.0));
  vec2 curve = local * local * (3.0 - 2.0 * local);
  return mix(mix(a, b, curve.x), mix(c, d, curve.x), curve.y);
}

vec3 blend_colors(float mixer, float softness) {
  float edge = 1.0 - softness;
  vec3 color = u_color_1.rgb;
  color = mix(
    color,
    u_color_2.rgb,
    smoothstep(0.35 * edge, 0.7 - 0.35 * edge, mixer)
  );
  color = mix(
    color,
    u_color_3.rgb,
    smoothstep(0.3 + 0.35 * edge, 1.0 - 0.35 * edge, mixer)
  );
  return color;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float time = 0.5 * u_time;
  float noise_scale = 0.0005 + 0.006 * u_scale;
  uv -= 0.5;
  uv *= noise_scale * u_resolution;
  uv = rotate_point(uv, u_rotation * 0.5 * PI);
  uv /= u_pixel_ratio;
  uv += 0.5;
  uv += u_offset;

  vec2 fragment_uv = gl_FragCoord.xy / u_resolution.xy;
  vec4 flow = texture(u_flow_map, fragment_uv);
  float influence = flow.r;
  vec2 flow_direction = (flow.gb - 0.5) * 2.0;

  float first_noise = noise(uv + time);
  float second_noise = noise(uv * 2.0 - time);
  float angle = first_noise * TWO_PI;
  float total_distortion = u_distortion + influence * u_distort_boost;
  uv.x += 4.0 * total_distortion * second_noise * cos(angle);
  uv.y += 4.0 * total_distortion * second_noise * sin(angle);
  uv += flow_direction * influence * 0.15;

  if (influence > 0.001) {
    float local_noise = noise(uv * 2.0 + time * 1.5);
    uv += influence * u_noise_boost * vec2(
      cos(local_noise * TWO_PI),
      sin(local_noise * TWO_PI)
    );
  }

  float iterations = ceil(clamp(u_swirl_iterations, 1.0, 30.0));
  float swirl_amount = clamp(u_swirl, 0.0, 2.0) + influence * u_swirl_boost;
  for (float iteration = 1.0; iteration <= 30.0; iteration++) {
    if (iteration > iterations) {
      break;
    }
    uv.x += swirl_amount / iteration * cos(time + iteration * 1.5 * uv.y);
    uv.y += swirl_amount / iteration * cos(time + iteration * uv.x);
  }

  float proportion = clamp(u_proportion, 0.0, 1.0);
  vec2 shaped_uv = uv * (0.5 + 3.5 * u_shape_scale);
  float shape = 0.5 + 0.5 * sin(shaped_uv.x) * cos(shaped_uv.y);
  float mixer = shape +
    0.48 * sign(proportion - 0.5) * pow(abs(proportion - 0.5), 0.5);
  out_color = vec4(
    blend_colors(mixer, clamp(u_softness, 0.0, 1.0)),
    1.0
  );
}
`;

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const normalizedHue = (((hue % 360) + 360) % 360) / 360;
  if (saturation === 0) {
    return [lightness, lightness, lightness] as const;
  }
  const hueToRgb = (p: number, q: number, value: number) => {
    let next = value;
    if (next < 0) {
      next += 1;
    }
    if (next > 1) {
      next -= 1;
    }
    if (next < 1 / 6) {
      return p + (q - p) * 6 * next;
    }
    if (next < 1 / 2) {
      return q;
    }
    if (next < 2 / 3) {
      return p + (q - p) * (2 / 3 - next) * 6;
    }
    return p;
  };
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [
    hueToRgb(p, q, normalizedHue + 1 / 3),
    hueToRgb(p, q, normalizedHue),
    hueToRgb(p, q, normalizedHue - 1 / 3),
  ] as const;
}

function palette(options: AquaFluidOptions) {
  const hue = (((options.hue + 217) % 360) + 360) % 360;
  const depth = Math.min(1, Math.max(0, options.depth / 100));
  const ramp = (deep: number, middle: number, pale: number) =>
    depth < 0.5
      ? deep + ((middle - deep) * depth) / 0.5
      : middle + ((pale - middle) * (depth - 0.5)) / 0.5;
  if (options.dark) {
    return [
      hslToRgb(hue, 0.85, ramp(0, 0.46, 0.62)),
      hslToRgb(hue, 0.9, ramp(0, 0.305, 0.45)),
      hslToRgb(hue, 0.5, ramp(0, 0.075, 0.1)),
    ] as const;
  }
  return [
    hslToRgb(hue, 1, ramp(0.27, 0.45, 0.9)),
    hslToRgb(hue, 0.55, 0.86),
    hslToRgb(hue, 0.25, 0.955),
  ] as const;
}

function compileShader(
  gl: WebGL2RenderingContext,
  source: string,
  type: number
) {
  const shader = gl.createShader(type);
  if (!shader) {
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  fragmentSource: string,
  shaders: WebGLShader[]
) {
  const vertex = compileShader(gl, VERTEX_SHADER, gl.VERTEX_SHADER);
  const fragment = compileShader(gl, fragmentSource, gl.FRAGMENT_SHADER);
  if (!(vertex && fragment)) {
    return null;
  }
  shaders.push(vertex, fragment);
  const program = gl.createProgram();
  if (!program) {
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export function attachAquaFluid(
  canvas: HTMLCanvasElement,
  initialOptions: AquaFluidOptions
): AquaFluidHandle | null {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    powerPreference: "low-power",
    premultipliedAlpha: false,
  });
  if (!gl) {
    return null;
  }

  const shaders: WebGLShader[] = [];
  const flowProgram = linkProgram(gl, FLOW_SHADER, shaders);
  const displayProgram = linkProgram(gl, DISPLAY_SHADER, shaders);
  const quadBuffer = gl.createBuffer();
  if (!(flowProgram && displayProgram && quadBuffer)) {
    return null;
  }

  const flowUniforms = {
    brushRadius: gl.getUniformLocation(flowProgram, "u_brush_radius"),
    brushStrength: gl.getUniformLocation(flowProgram, "u_brush_strength"),
    decay: gl.getUniformLocation(flowProgram, "u_decay"),
    pointer: gl.getUniformLocation(flowProgram, "u_pointer"),
    previous: gl.getUniformLocation(flowProgram, "u_previous"),
    velocity: gl.getUniformLocation(flowProgram, "u_velocity"),
  };
  const displayUniforms = {
    color1: gl.getUniformLocation(displayProgram, "u_color_1"),
    color2: gl.getUniformLocation(displayProgram, "u_color_2"),
    color3: gl.getUniformLocation(displayProgram, "u_color_3"),
    distortBoost: gl.getUniformLocation(displayProgram, "u_distort_boost"),
    distortion: gl.getUniformLocation(displayProgram, "u_distortion"),
    flowMap: gl.getUniformLocation(displayProgram, "u_flow_map"),
    noiseBoost: gl.getUniformLocation(displayProgram, "u_noise_boost"),
    offset: gl.getUniformLocation(displayProgram, "u_offset"),
    pixelRatio: gl.getUniformLocation(displayProgram, "u_pixel_ratio"),
    proportion: gl.getUniformLocation(displayProgram, "u_proportion"),
    resolution: gl.getUniformLocation(displayProgram, "u_resolution"),
    rotation: gl.getUniformLocation(displayProgram, "u_rotation"),
    scale: gl.getUniformLocation(displayProgram, "u_scale"),
    shapeScale: gl.getUniformLocation(displayProgram, "u_shape_scale"),
    softness: gl.getUniformLocation(displayProgram, "u_softness"),
    swirl: gl.getUniformLocation(displayProgram, "u_swirl"),
    swirlBoost: gl.getUniformLocation(displayProgram, "u_swirl_boost"),
    swirlIterations: gl.getUniformLocation(
      displayProgram,
      "u_swirl_iterations"
    ),
    time: gl.getUniformLocation(displayProgram, "u_time"),
  };

  const activateProgram = gl.useProgram.bind(gl);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );

  const bindQuad = (program: WebGLProgram) => {
    const position = gl.getAttribLocation(program, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  };
  const makeTarget = (width: number, height: number): FlowTarget | null => {
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!(texture && framebuffer)) {
      return null;
    }
    const initial = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      initial[index * 4 + 1] = 128;
      initial[index * 4 + 2] = 128;
      initial[index * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      initial
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { framebuffer, texture };
  };
  const deleteTarget = (target: FlowTarget | null) => {
    if (!target) {
      return;
    }
    gl.deleteFramebuffer(target.framebuffer);
    gl.deleteTexture(target.texture);
  };

  let options = initialOptions;
  let width = 0;
  let height = 0;
  let flowWidth = 0;
  let flowHeight = 0;
  let targetA: FlowTarget | null = null;
  let targetB: FlowTarget | null = null;
  let flip = false;
  let animationFrame = 0;
  let previousFrame = 0;
  let disposed = false;
  const startedAt = performance.now();
  const pointer = {
    smoothX: 0.5,
    smoothY: 0.5,
    velocityX: 0,
    velocityY: 0,
    x: 0.5,
    y: 0.5,
  };

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    const nextWidth = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const nextHeight = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (nextWidth === width && nextHeight === height) {
      return;
    }
    width = nextWidth;
    height = nextHeight;
    canvas.width = width;
    canvas.height = height;
    flowWidth = Math.max(1, Math.round(width / 4));
    flowHeight = Math.max(1, Math.round(height / 4));
    deleteTarget(targetA);
    deleteTarget(targetB);
    targetA = makeTarget(flowWidth, flowHeight);
    targetB = makeTarget(flowWidth, flowHeight);
    flip = false;
  };

  const draw = (now: number) => {
    resize();
    if (!(targetA && targetB)) {
      return;
    }
    pointer.velocityX *= 0.94;
    pointer.velocityY *= 0.94;
    pointer.smoothX += (pointer.x - pointer.smoothX) * 0.12;
    pointer.smoothY += (pointer.y - pointer.smoothY) * 0.12;
    pointer.velocityX +=
      ((pointer.x - pointer.smoothX) * 0.5 - pointer.velocityX) * 0.15;
    pointer.velocityY +=
      ((pointer.y - pointer.smoothY) * 0.5 - pointer.velocityY) * 0.15;

    const read = flip ? targetA : targetB;
    const write = flip ? targetB : targetA;
    flip = !flip;
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.framebuffer);
    gl.viewport(0, 0, flowWidth, flowHeight);
    activateProgram(flowProgram);
    bindQuad(flowProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.texture);
    gl.uniform1i(flowUniforms.previous, 0);
    gl.uniform2f(flowUniforms.pointer, pointer.smoothX, pointer.smoothY);
    gl.uniform2f(flowUniforms.velocity, pointer.velocityX, pointer.velocityY);
    gl.uniform1f(flowUniforms.brushRadius, 0.22);
    gl.uniform1f(flowUniforms.brushStrength, 1.1);
    gl.uniform1f(flowUniforms.decay, 0.96);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    activateProgram(displayProgram);
    bindQuad(displayProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, write.texture);
    gl.uniform1i(displayUniforms.flowMap, 0);
    gl.uniform1f(displayUniforms.time, ((now - startedAt) / 1000) * 0.14);
    gl.uniform1f(displayUniforms.pixelRatio, window.devicePixelRatio || 1);
    gl.uniform2f(displayUniforms.resolution, width, height);
    gl.uniform1f(displayUniforms.scale, 0.5);
    gl.uniform1f(displayUniforms.rotation, -5 / 90);
    gl.uniform2f(displayUniforms.offset, 0, 0.65);
    const colors = palette(options);
    gl.uniform4f(
      displayUniforms.color1,
      colors[0][0],
      colors[0][1],
      colors[0][2],
      1
    );
    gl.uniform4f(
      displayUniforms.color2,
      colors[1][0],
      colors[1][1],
      colors[1][2],
      1
    );
    gl.uniform4f(
      displayUniforms.color3,
      colors[2][0],
      colors[2][1],
      colors[2][2],
      1
    );
    gl.uniform1f(displayUniforms.proportion, 0.5);
    gl.uniform1f(displayUniforms.softness, 1);
    gl.uniform1f(displayUniforms.shapeScale, 0.1);
    gl.uniform1f(displayUniforms.distortion, 0.2);
    gl.uniform1f(displayUniforms.swirl, 0.24);
    gl.uniform1f(displayUniforms.swirlIterations, 8);
    gl.uniform1f(displayUniforms.distortBoost, 1.35);
    gl.uniform1f(displayUniforms.noiseBoost, 0);
    gl.uniform1f(displayUniforms.swirlBoost, 0.45);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const frame = (now: number) => {
    animationFrame = window.requestAnimationFrame(frame);
    if (
      document.visibilityState !== "visible" ||
      now - previousFrame < 1000 / 30
    ) {
      return;
    }
    previousFrame = now - ((now - previousFrame) % (1000 / 30));
    draw(now);
  };
  const pointerMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width;
    pointer.y = 1 - (event.clientY - rect.top) / rect.height;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  window.addEventListener("pointermove", pointerMove, { passive: true });
  resize();
  draw(performance.now());
  if (!options.reducedMotion) {
    animationFrame = window.requestAnimationFrame(frame);
  }

  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      observer.disconnect();
      window.removeEventListener("pointermove", pointerMove);
      window.cancelAnimationFrame(animationFrame);
      deleteTarget(targetA);
      deleteTarget(targetB);
      gl.deleteBuffer(quadBuffer);
      gl.deleteProgram(flowProgram);
      gl.deleteProgram(displayProgram);
      for (const shader of shaders) {
        gl.deleteShader(shader);
      }
    },
    setOptions: (nextOptions) => {
      const resume = options.reducedMotion && !nextOptions.reducedMotion;
      options = nextOptions;
      if (resume) {
        animationFrame = window.requestAnimationFrame(frame);
      } else if (nextOptions.reducedMotion) {
        window.cancelAnimationFrame(animationFrame);
        draw(performance.now());
      }
    },
  };
}
