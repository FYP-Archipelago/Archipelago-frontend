/**
 * The picture, in three.js.
 *
 * Two references shaped this, and each contributed one thing:
 *
 *   - **The old Plotly scene** contributed how it *moves*. The data sits in a
 *     fixed cube and only the camera turns around it, with fitness pinned as the
 *     up axis, so the frame never jumps. Nothing here refits the camera when a
 *     control changes; it resets only for a new run, a switch between the 3D and
 *     2D layouts, or the Reset view button. Panning is off in 3D, so the cube
 *     cannot drift out of the middle of the canvas.
 *   - **STN Analytics** (stn-analytics.com, the reference STN tool) contributed
 *     how nodes *look*: lit spheres sized by the cube root of visits, an amber box
 *     where a trajectory starts, a cone where it ends, a red sphere for the best
 *     location found, and grey for a location more than one trajectory reached.
 *     Here a trajectory is an island's lineage, so "more than one" means islands.
 *
 * Cost is kept low deliberately, so a machine without a discrete GPU still
 * draws it. Each node shape is one instanced draw call, spheres are low-poly,
 * edges are plain 1px lines, and a frame is rendered only when the camera or the
 * data actually changes -- an idle view costs nothing.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { NodeFlag } from "../contract/schema.js";
import type { LayoutPayload, StnPayload } from "../data/worker/data.worker.js";

/** The palette's island cycle. Must match tokens.css. */
const ISLAND_HEX = [0x5ac8b8, 0xf2a65a, 0x7fa7e8, 0xc88be0, 0x8fd16a, 0xe8756b];
const START_HEX = 0xfbbf24; // STN Analytics' start box
const END_HEX = 0xdde8e9; // STN draws ends dark; on this ground that vanishes, so ink
const BEST_HEX = 0xef4444; // STN's best node
const SHARED_HEX = 0x9aa7ad; // STN's grey, shifted toward the palette's teal cast
const MIGRATION_HEX = 0xff4d9d;
const DEEP_HEX = 0x08171f;
const RULE_HEX = 0x244251;
const GRID_HEX = 0x16303c;
const INK_FAINT = "#708a91";

/** Half the side of the cube the data is fitted into. */
const HALF = 1;

export interface StnSceneProps {
  payload: StnPayload;
  layout: LayoutPayload;
  /** Density that maps to full opacity. Lower burns more edges in. */
  exposure: number;
  nodeScale: number;
  showMigrations: boolean;
  showFrame: boolean;
  hiddenIslands: ReadonlySet<number>;
  /** Changing this puts the camera back to its starting position. */
  resetToken: string;
  onError: (message: string) => void;
}

type Kind = "sphere" | "shared" | "start" | "end" | "best";

interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  perspective: THREE.PerspectiveCamera;
  orthographic: THREE.OrthographicCamera;
  orbit: OrbitControls;
  pan: OrbitControls;
  content: THREE.Group;
  frame: THREE.Group;
  dirty: boolean;
  dims: 2 | 3;
}

export function StnScene({
  payload, layout, exposure, nodeScale, showMigrations, showFrame,
  hiddenIslands, resetToken, onError,
}: StnSceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Stage | null>(null);
  const edgeMaterialRef = useRef<THREE.LineBasicMaterial | null>(null);
  const migrationRef = useRef<THREE.LineSegments | null>(null);

  const n = payload.nodeCount;
  const is3d = layout.dims === 3;

  /**
   * Positions fitted into a fixed cube. In 3D each axis is stretched to the same
   * length, as Plotly's `aspectmode: "cube"` did, so the box is identical for
   * every run and every toggle. The 2D layout keeps its own proportions, since
   * there both axes share a unit.
   */
  const fitted = useMemo(() => {
    const { min, max } = layout.bounds;
    const out = new Float32Array(n * 3);
    const span = [max[0] - min[0] || 1, max[1] - min[1] || 1, max[2] - min[2] || 1];
    const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const uniform = (2 * HALF) / Math.max(span[0]!, span[1]!);
    for (let i = 0; i < n; i += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = layout.positions[i * 3 + axis]! - centre[axis]!;
        out[i * 3 + axis] = is3d
          ? (value / span[axis]!) * 2 * HALF
          : axis === 2 ? 0 : value * uniform;
      }
    }
    return out;
  }, [layout, n, is3d]);

  /** Which shape each node takes, in STN precedence: best, end, start, shared. */
  const kinds = useMemo(() => {
    const incoming = new Uint32Array(n);
    for (let i = 0; i < payload.edgeTarget.length; i += 1) incoming[payload.edgeTarget[i]!]! += 1;
    // An arrived migrant has no trajectory parent on its own island -- its parent
    // moved to the migration layer -- so it is not the start of anything.
    const arrived = new Uint8Array(n);
    for (let i = 0; i < payload.migrationTarget.length; i += 1) arrived[payload.migrationTarget[i]!] = 1;

    let best = payload.maximising ? -Infinity : Infinity;
    for (let i = 0; i < n; i += 1) {
      const value = payload.fitness[i]!;
      if (payload.maximising ? value > best : value < best) best = value;
    }

    const out: Kind[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const flags = payload.flags[i]!;
      if (payload.fitness[i] === best) out[i] = "best";
      else if ((flags & NodeFlag.FinalBest) !== 0) out[i] = "end";
      else if (incoming[i] === 0 && arrived[i] === 0) out[i] = "start";
      else if ((flags & NodeFlag.Shared) !== 0) out[i] = "shared";
      else out[i] = "sphere";
    }
    return out;
  }, [payload, n]);

  // ---- stage: renderer, cameras, controls, lights, render loop -----------
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "default" });
    } catch (error) {
      onError(`WebGL is not available in this browser (${String(error)})`);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(DEEP_HEX, 1);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    const perspective = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
    // Fitness is z, so z is up -- set before the controls read it.
    perspective.up.set(0, 0, 1);
    const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);

    // Lighting that travels with the camera, so a sphere is always lit from the
    // viewer's upper left and reads as round from any angle.
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-1, 1.2, 2);
    perspective.add(key);
    const orthoKey = new THREE.DirectionalLight(0xffffff, 1.6);
    orthoKey.position.set(-1, 1.2, 2);
    orthographic.add(orthoKey);
    scene.add(perspective, orthographic);
    scene.add(new THREE.HemisphereLight(0xdde8e9, 0x0e2530, 1.15));

    const orbit = new OrbitControls(perspective, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.09;
    orbit.rotateSpeed = 0.75;
    orbit.zoomSpeed = 0.9;
    orbit.enablePan = false; // the cube stays in the middle of the canvas
    orbit.minDistance = 1.2;
    orbit.maxDistance = 14;

    const pan = new OrbitControls(orthographic, renderer.domElement);
    pan.enableRotate = false;
    pan.enableDamping = true;
    pan.dampingFactor = 0.12;
    pan.screenSpacePanning = true;
    pan.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    pan.minZoom = 0.4;
    pan.maxZoom = 40;

    const content = new THREE.Group();
    const frame = new THREE.Group();
    scene.add(frame, content);

    const stage: Stage = {
      renderer, scene, perspective, orthographic, orbit, pan, content, frame,
      dirty: true, dims: 3,
    };
    stageRef.current = stage;
    const markDirty = () => { stage.dirty = true; };
    orbit.addEventListener("change", markDirty);
    pan.addEventListener("change", markDirty);

    const resize = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      perspective.aspect = width / height;
      perspective.updateProjectionMatrix();
      const halfHeight = 1.18;
      orthographic.left = -halfHeight * (width / height);
      orthographic.right = halfHeight * (width / height);
      orthographic.top = halfHeight;
      orthographic.bottom = -halfHeight;
      orthographic.updateProjectionMatrix();
      stage.dirty = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    let frameId = 0;
    const loop = () => {
      frameId = requestAnimationFrame(loop);
      const controls = stage.dims === 3 ? orbit : pan;
      const moved = controls.update();
      if (!moved && !stage.dirty) return;
      stage.dirty = false;
      renderer.render(scene, stage.dims === 3 ? perspective : orthographic);
    };
    loop();

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      orbit.dispose();
      pan.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
      stageRef.current = null;
    };
    // onError is a callback prop; the stage must not be rebuilt when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- camera: reset only for a new run, a 2D/3D switch, or the button ----
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    stage.dims = layout.dims;
    stage.orbit.enabled = layout.dims === 3;
    stage.pan.enabled = layout.dims === 2;

    // The old Plotly scene's default eye, (1.55, 1.45, 0.85), at a distance that
    // holds the whole cube with a margin.
    stage.orbit.target.set(0, 0, 0);
    stage.perspective.position.set(1.55, 1.45, 0.85).normalize().multiplyScalar(4.6);
    stage.perspective.lookAt(0, 0, 0);
    stage.orbit.update();

    stage.pan.target.set(0, 0, 0);
    stage.orthographic.position.set(0, 0, 10);
    stage.orthographic.zoom = 1;
    stage.orthographic.updateProjectionMatrix();
    stage.pan.update();
    stage.dirty = true;
  }, [resetToken, layout.dims]);

  // ---- the cube, floor grid and axis names --------------------------------
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    disposeChildren(stage.frame);
    if (is3d) {
      const box = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(2 * HALF, 2 * HALF, 2 * HALF)),
        new THREE.LineBasicMaterial({ color: RULE_HEX, transparent: true, opacity: 0.9 }),
      );
      stage.frame.add(box);

      const grid = new THREE.GridHelper(2 * HALF, 10, GRID_HEX, GRID_HEX);
      grid.rotateX(Math.PI / 2); // GridHelper lies in XZ; the floor here is XY
      grid.position.z = -HALF;
      stage.frame.add(grid);

      const [xName, yName, zName] = layout.provenance.axisLabels;
      stage.frame.add(label(xName, [0, -HALF - 0.28, -HALF]));
      stage.frame.add(label(yName, [HALF + 0.3, 0, -HALF]));
      stage.frame.add(label(zName, [-HALF - 0.3, -HALF - 0.3, 0]));
    }
    stage.frame.visible = showFrame;
    stage.dirty = true;
  }, [is3d, layout.provenance, showFrame]);

  // ---- nodes, edges and migrations -----------------------------------------
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    disposeChildren(stage.content);

    // Node radius in cube units, from the cube root of visits as STN Analytics
    // sizes them: a hot spot reads bigger without swamping the rest.
    const base = (is3d ? 0.0145 : 0.0115) * nodeScale;
    const radius = (i: number) => base * Math.cbrt(Math.max(payload.visits[i]!, 1));

    const byKind: Record<Kind, number[]> = { sphere: [], shared: [], start: [], end: [], best: [] };
    for (let i = 0; i < n; i += 1) {
      if (hiddenIslands.has(payload.islandId[i]!)) continue;
      byKind[kinds[i]!].push(i);
    }

    const sphere = new THREE.SphereGeometry(1, 14, 10);
    const cube = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    // Cone tip up the fitness axis in 3D, up the screen in 2D.
    const cone = new THREE.ConeGeometry(1.15, 2.5, 12);
    if (is3d) cone.rotateX(Math.PI / 2);

    const matrix = new THREE.Matrix4();
    const colour = new THREE.Color();
    const place = (
      indices: number[],
      geometry: THREE.BufferGeometry,
      size: (i: number) => number,
      tint: (i: number) => number,
    ) => {
      if (indices.length === 0) return;
      const mesh = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshLambertMaterial({ color: 0xffffff }),
        indices.length,
      );
      indices.forEach((node, slot) => {
        const s = size(node);
        matrix.makeScale(s, s, s);
        matrix.setPosition(fitted[node * 3]!, fitted[node * 3 + 1]!, fitted[node * 3 + 2]!);
        mesh.setMatrixAt(slot, matrix);
        mesh.setColorAt(slot, colour.setHex(tint(node)));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      stage.content.add(mesh);
    };

    const islandTint = (i: number) => ISLAND_HEX[payload.islandId[i]! % ISLAND_HEX.length]!;
    place(byKind.sphere, sphere, radius, islandTint);
    place(byKind.shared, sphere, radius, () => SHARED_HEX);
    place(byKind.start, cube, (i) => Math.max(radius(i), base) * 1.25, () => START_HEX);
    place(byKind.end, cone, (i) => Math.max(radius(i), base) * 1.9, () => END_HEX);
    place(byKind.best, sphere, (i) => Math.max(radius(i), base) * 2.6, () => BEST_HEX);

    // Trajectory edges: additive, so where the search re-walked a route it burns
    // brighter. Weight is baked into the vertex colour; exposure is the material's
    // opacity, so dragging the slider never rebuilds a buffer.
    const linearIsland = ISLAND_HEX.map((hex) => new THREE.Color().setHex(hex));
    const count = payload.edgeSource.length;
    const edgePositions = new Float32Array(count * 6);
    const edgeColours = new Float32Array(count * 6);
    let written = 0;
    for (let e = 0; e < count; e += 1) {
      const a = payload.edgeSource[e]!;
      const b = payload.edgeTarget[e]!;
      const island = payload.islandId[a]!;
      if (hiddenIslands.has(island)) continue;
      // Colours are converted to linear light first: three.js accumulates and
      // blends in linear space, so a raw sRGB weight lands several times
      // brighter than intended and the core washes out to white.
      const tint = linearIsland[island % linearIsland.length]!;
      const intensity = Math.min(1, 0.35 + 0.25 * (payload.edgeWeight[e]! - 1));
      const r = tint.r * intensity;
      const g = tint.g * intensity;
      const bl = tint.b * intensity;
      for (let end = 0; end < 2; end += 1) {
        const node = end === 0 ? a : b;
        const at = written * 6 + end * 3;
        edgePositions[at] = fitted[node * 3]!;
        edgePositions[at + 1] = fitted[node * 3 + 1]!;
        edgePositions[at + 2] = fitted[node * 3 + 2]!;
        edgeColours[at] = r;
        edgeColours[at + 1] = g;
        edgeColours[at + 2] = bl;
      }
      written += 1;
    }
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions.subarray(0, written * 6), 3));
    edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColours.subarray(0, written * 6), 3));
    const edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: edgeOpacity(exposure),
    });
    edgeMaterialRef.current = edgeMaterial;
    stage.content.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    // Migrations stay out of the additive field -- magenta is reserved for them,
    // and a field that blends hues would let a dense region drift pink.
    const migrationPositions: number[] = [];
    for (let m = 0; m < payload.migrationSource.length; m += 1) {
      const a = payload.migrationSource[m]!;
      const b = payload.migrationTarget[m]!;
      if (hiddenIslands.has(payload.islandId[a]!) && hiddenIslands.has(payload.islandId[b]!)) continue;
      migrationPositions.push(
        fitted[a * 3]!, fitted[a * 3 + 1]!, fitted[a * 3 + 2]!,
        fitted[b * 3]!, fitted[b * 3 + 1]!, fitted[b * 3 + 2]!,
      );
    }
    const migrationGeometry = new THREE.BufferGeometry();
    migrationGeometry.setAttribute("position", new THREE.Float32BufferAttribute(migrationPositions, 3));
    const migrations = new THREE.LineSegments(
      migrationGeometry,
      new THREE.LineBasicMaterial({ color: MIGRATION_HEX, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    migrations.visible = showMigrations;
    migrationRef.current = migrations;
    stage.content.add(migrations);

    stage.dirty = true;
    // exposure and showMigrations are applied by their own cheap effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, fitted, kinds, hiddenIslands, nodeScale, is3d, n]);

  useEffect(() => {
    const material = edgeMaterialRef.current;
    const stage = stageRef.current;
    if (material === null || stage === null) return;
    material.opacity = edgeOpacity(exposure);
    stage.dirty = true;
  }, [exposure]);

  useEffect(() => {
    const migrations = migrationRef.current;
    const stage = stageRef.current;
    if (migrations === null || stage === null) return;
    migrations.visible = showMigrations;
    stage.dirty = true;
  }, [showMigrations]);

  return <div ref={hostRef} style={{ position: "absolute", inset: "0" }} />;
}

/** Lower exposure burns more of the field in; the curve keeps the slider useful. */
function edgeOpacity(exposure: number): number {
  return Math.min(1, Math.max(0.004, 0.06 / exposure));
}

/** A camera-facing text label, sized in world units so it shrinks with distance. */
function label(text: string, at: [number, number, number]): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (context !== null) {
    context.font = '500 34px Archivo, "Segoe UI", sans-serif';
    context.fillStyle = INK_FAINT;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 256, 48);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(1.2, 0.225, 1);
  sprite.position.set(...at);
  return sprite;
}

function disposeChildren(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    disposeTree(child);
    group.remove(child);
  }
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material !== undefined) {
      (material as THREE.SpriteMaterial).map?.dispose();
      material.dispose();
    }
  });
}
