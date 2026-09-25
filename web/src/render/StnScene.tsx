/**
 * The picture, in three.js, handled the way the old Plotly scene was.
 *
 * What made the Streamlit view easy to look around was Plotly's *turntable*
 * camera, and this reproduces its three parts:
 *
 *   - **A fixed box with walls.** The data sits in a cube and only the camera
 *     moves. The three walls on the far side of the camera carry a grid, and they
 *     swap as the camera turns -- exactly as Plotly draws its scene -- so there is
 *     always a floor and a back behind the data, and the box reads as solid.
 *   - **Fitness pinned as up.** Dragging sideways turns the table about the
 *     fitness axis; dragging vertically tilts it. The camera never rolls.
 *   - **Direct manipulation.** No inertia -- the view stops when the mouse
 *     stops. Scroll zooms, double-click resets, and panning is off so the box
 *     cannot drift away from the middle.
 *
 * Nodes are screen-space points drawn as shaded balls by a small shader: a
 * constant size in pixels like Plotly's markers, so a zoom never turns them into
 * boulders, with shading and a darker edge that keep overlapping nodes apart.
 * One draw call for every node, which is also what keeps this usable on a
 * machine without a discrete GPU. A frame is only rendered when the camera or
 * the data changes, so an idle view costs nothing.
 *
 * Picking is done in screen space: a click projects every visible node and takes
 * the front-most one whose disc covers the pointer, which is exactly the node
 * the viewer sees there. A press that moves more than a few pixels is a drag and
 * turns the table instead. Only the node's index leaves this file; its record
 * comes from the worker.
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { NodeFlag } from "../contract/schema.js";
import type { LayoutPayload, StnPayload } from "../data/worker/data.worker.js";
import type { Lineage, NeighbourRef } from "../data/stn/inspect.js";
import { SCENE, type ScenePalette, type ThemeName } from "../theme/palette.js";

/** Half the side of the cube the data is fitted into. */
const HALF = 1;
/** Plotly's default eye, (1.55, 1.45, 0.85), at a distance that holds the box. */
const EYE = new THREE.Vector3(1.55, 1.45, 0.85).normalize().multiplyScalar(5.7);

export interface StnSceneProps {
  payload: StnPayload;
  layout: LayoutPayload;
  /** Multiplies trajectory edge opacity; 1 is the default. */
  edgeIntensity: number;
  nodeScale: number;
  showMigrations: boolean;
  showFrame: boolean;
  hiddenIslands: ReadonlySet<number>;
  theme: ThemeName;
  /** Changing this puts the camera back to its starting position. */
  resetToken: string;
  onError: (message: string) => void;
  colourBy: "island" | "fitness";
  focus: Focus;
  /** A click: the node under the pointer, or null for empty space. */
  onPick: (index: number | null) => void;
  /** The node under a still pointer, in canvas pixels, or null. */
  onHover: (hover: { index: number; x: number; y: number } | null) => void;
  /** Filled with the scene's imperative actions while it is mounted. */
  apiRef: { current: SceneApi | null };
}

/** What is selected, and what to draw around it. */
export interface Focus {
  selected: number | null;
  parents: readonly NeighbourRef[];
  children: readonly NeighbourRef[];
  lineage: Lineage | null;
}

export interface SceneApi {
  /** The current view as a PNG data URL. */
  capture: () => string | null;
  /** Move the camera so it turns about this node instead of the box's centre. */
  centreOn: (index: number) => void;
}

/** What picking needs, kept in a ref so the pointer handlers never go stale. */
interface Pickable {
  positions: Float32Array;
  /** On-screen diameter of each node in CSS pixels; 0 when hidden. */
  sizes: Float32Array;
  /** Gold markers, drawn over everything, so they win a pick first. */
  finals: Array<{ index: number; size: number }>;
}

interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  perspective: THREE.PerspectiveCamera;
  orthographic: THREE.OrthographicCamera;
  orbit: OrbitControls;
  pan: OrbitControls;
  content: THREE.Group;
  focus: THREE.Group;
  box: BoxParts | null;
  dirty: boolean;
  dims: 2 | 3;
}

/** The pieces of the plot box that follow the camera. */
interface BoxParts {
  group: THREE.Group;
  /** walls[axis][side]: side 0 sits at -1, side 1 at +1. */
  walls: THREE.Object3D[][];
  titles: THREE.Sprite[];
}

export function StnScene({
  payload, layout, edgeIntensity, nodeScale, showMigrations, showFrame,
  hiddenIslands, theme, resetToken, onError,
  colourBy, focus, onPick, onHover, apiRef,
}: StnSceneProps) {
  const palette = SCENE[theme];
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<Stage | null>(null);
  const edgeMaterialRef = useRef<THREE.LineBasicMaterial | null>(null);
  const migrationRef = useRef<THREE.LineSegments | null>(null);
  const nodesRef = useRef<THREE.Points | null>(null);
  const pickRef = useRef<Pickable | null>(null);
  const lineageOnRef = useRef(false);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const onPickRef = useRef(onPick);
  const onHoverRef = useRef(onHover);
  onPickRef.current = onPick;
  onHoverRef.current = onHover;

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

  /** The best fitness in the run, so the winning island's marker can stand out. */
  const bestFitness = useMemo(() => {
    let best = payload.maximising ? -Infinity : Infinity;
    for (let i = 0; i < n; i += 1) {
      const value = payload.fitness[i]!;
      if (payload.maximising ? value > best : value < best) best = value;
    }
    return best;
  }, [payload, n]);

  /**
   * Colour by fitness: position in the run's ranking, not raw value, so a few
   * terrible early points do not crush every other node into one colour.
   * 1 is the best node.
   */
  const fitnessShade = useMemo(() => {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) =>
      payload.maximising ? payload.fitness[b]! - payload.fitness[a]! : payload.fitness[a]! - payload.fitness[b]!,
    );
    const shade = new Float32Array(n);
    order.forEach((node, rank) => { shade[node] = n > 1 ? 1 - rank / (n - 1) : 1; });
    return shade;
  }, [payload, n]);

  // ---- stage: renderer, cameras, controls, render loop --------------------
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
    renderer.setClearColor(SCENE[theme].canvas, 1);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const perspective = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    perspective.up.set(0, 0, 1); // fitness is z, so z is up
    const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
    scene.add(perspective, orthographic);

    // Turntable: sideways turns about the up axis, vertical tilts, no roll, no
    // drift after release, no panning.
    const orbit = new OrbitControls(perspective, renderer.domElement);
    orbit.enableDamping = false;
    orbit.enablePan = false;
    orbit.rotateSpeed = 0.85;
    orbit.zoomSpeed = 0.9;
    orbit.minDistance = 2;
    orbit.maxDistance = 12;
    orbit.minPolarAngle = 0.05;
    orbit.maxPolarAngle = Math.PI - 0.05;

    // The flat graph layout is a map: it pans and zooms, it does not turn.
    const pan = new OrbitControls(orthographic, renderer.domElement);
    pan.enableRotate = false;
    pan.enableDamping = false;
    pan.screenSpacePanning = true;
    pan.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    pan.minZoom = 0.4;
    pan.maxZoom = 40;

    const content = new THREE.Group();
    const focusGroup = new THREE.Group();
    scene.add(content, focusGroup);

    const stage: Stage = {
      renderer, scene, perspective, orthographic, orbit, pan, content,
      focus: focusGroup, box: null, dirty: true, dims: 3,
    };
    stageRef.current = stage;

    // A tooltip left over from before the camera moved points at the wrong place.
    let hovering = false;
    const dropHover = () => {
      if (!hovering) return;
      hovering = false;
      onHoverRef.current(null);
    };
    orbit.addEventListener("change", () => {
      if (stage.box !== null) orientBox(stage.box, perspective.position);
      stage.dirty = true;
      dropHover();
    });
    pan.addEventListener("change", () => {
      stage.dirty = true;
      dropHover();
    });

    // ---- picking ---------------------------------------------------------
    const canvas = renderer.domElement;
    const viewProjection = new THREE.Matrix4();
    const pickAt = (clientX: number, clientY: number): number | null => {
      const pickable = pickRef.current;
      if (pickable === null) return null;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const camera = stage.dims === 3 ? perspective : orthographic;
      camera.updateMatrixWorld();
      const m = viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
      const { positions, sizes, finals } = pickable;
      const w = rect.width;
      const h = rect.height;
      let sx = 0;
      let sy = 0;
      let depth = 0;
      const project = (i: number): boolean => {
        const x = positions[i * 3]!;
        const y = positions[i * 3 + 1]!;
        const z = positions[i * 3 + 2]!;
        const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
        if (cw <= 0) return false;
        sx = ((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw * 0.5 + 0.5) * w;
        sy = (0.5 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw * 0.5) * h;
        depth = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / cw;
        return true;
      };
      for (const final of finals) {
        if (project(final.index) && Math.hypot(sx - px, sy - py) <= final.size / 2 + 2) return final.index;
      }
      let front = -1;
      let frontDepth = Infinity;
      let near = -1;
      let nearDistance = Infinity;
      for (let i = 0; i < sizes.length; i += 1) {
        const size = sizes[i]!;
        if (size === 0 || !project(i)) continue;
        const d = Math.hypot(sx - px, sy - py);
        if (d <= size / 2 + 1.5 && depth < frontDepth) {
          front = i;
          frontDepth = depth;
        }
        if (d < nearDistance) {
          nearDistance = d;
          near = i;
        }
      }
      if (front >= 0) return front;
      // A near miss on a small node still counts; a click in empty space does not.
      return nearDistance <= 6 ? near : null;
    };

    let pressed: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => { pressed = { x: event.clientX, y: event.clientY }; };
    const onUp = (event: PointerEvent) => {
      if (pressed === null) return;
      const moved = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y);
      pressed = null;
      if (moved < 5 && event.button === 0) onPickRef.current(pickAt(event.clientX, event.clientY));
    };
    let hoverFrame = 0;
    let lastMove: PointerEvent | null = null;
    const onMove = (event: PointerEvent) => {
      if (event.buttons !== 0) {
        dropHover();
        return;
      }
      lastMove = event;
      if (hoverFrame !== 0) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        const move = lastMove;
        if (move === null) return;
        const index = pickAt(move.clientX, move.clientY);
        canvas.style.cursor = index === null ? "" : "pointer";
        if (index === null) {
          dropHover();
          return;
        }
        const rect = canvas.getBoundingClientRect();
        hovering = true;
        onHoverRef.current({ index, x: move.clientX - rect.left, y: move.clientY - rect.top });
      });
    };
    const onLeave = () => {
      canvas.style.cursor = "";
      dropHover();
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

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
      if (!stage.dirty) return;
      stage.dirty = false;
      renderer.render(scene, stage.dims === 3 ? perspective : orthographic);
    };
    loop();

    return () => {
      cancelAnimationFrame(frameId);
      cancelAnimationFrame(hoverFrame);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      observer.disconnect();
      orbit.dispose();
      pan.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
      stageRef.current = null;
    };
    // The stage is built once; theme and callbacks are applied by other effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- camera: reset for a new run, a 2D/3D switch, the button, a double-click
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    stage.dims = layout.dims;
    stage.orbit.enabled = layout.dims === 3;
    stage.pan.enabled = layout.dims === 2;

    const reset = () => {
      stage.orbit.target.set(0, 0, 0);
      stage.perspective.position.copy(EYE);
      stage.perspective.lookAt(0, 0, 0);
      stage.orbit.update();
      stage.pan.target.set(0, 0, 0);
      stage.orthographic.position.set(0, 0, 10);
      stage.orthographic.zoom = 1;
      stage.orthographic.updateProjectionMatrix();
      stage.pan.update();
      if (stage.box !== null) orientBox(stage.box, stage.perspective.position);
      stage.dirty = true;
    };
    reset();

    const canvas = stage.renderer.domElement;
    canvas.addEventListener("dblclick", reset);
    return () => canvas.removeEventListener("dblclick", reset);
  }, [resetToken, layout.dims]);

  // ---- theme ground --------------------------------------------------------
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    stage.renderer.setClearColor(palette.canvas, 1);
    stage.dirty = true;
  }, [palette]);

  // ---- the plot box: walls, grid, axis titles ------------------------------
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    if (stage.box !== null) {
      disposeTree(stage.box.group);
      stage.scene.remove(stage.box.group);
      stage.box = null;
    }
    if (is3d) {
      stage.box = buildBox(palette, layout.provenance.axisLabels);
      stage.scene.add(stage.box.group);
      orientBox(stage.box, stage.perspective.position);
      stage.box.group.visible = showFrame;
    }
    stage.dirty = true;
  }, [is3d, layout.provenance, palette, showFrame]);

  // ---- nodes, edges and migrations -----------------------------------------
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    disposeChildren(stage.content);
    const pixelRatio = stage.renderer.getPixelRatio();

    // Every node: one draw call, sized by visits in screen pixels as the old
    // Plotly markers were (3 + 2.4 * visits^0.7 there, a little larger here, since
    // shading reads better with a few more pixels to work with).
    const nodePositions = new Float32Array(n * 3);
    const nodeColours = new Float32Array(n * 3);
    const nodeSizes = new Float32Array(n);
    const nodeShapes = new Float32Array(n);
    const islandRgb = palette.islands.map(cssToRgb);
    for (let i = 0; i < n; i += 1) {
      nodePositions.set(fitted.subarray(i * 3, i * 3 + 3), i * 3);
      const rgb = colourBy === "fitness"
        ? viridis(fitnessShade[i]!)
        : islandRgb[payload.islandId[i]! % islandRgb.length]!;
      nodeColours.set(rgb, i * 3);
      nodeSizes[i] = hiddenIslands.has(payload.islandId[i]!)
        ? 0
        : (5.5 + 2.4 * Math.pow(Math.min(payload.visits[i]!, 8), 0.7)) * nodeScale;
    }
    const nodes = pointCloud(nodePositions, nodeColours, nodeSizes, nodeShapes, pixelRatio, false, palette);
    nodesRef.current = nodes;
    // Rebuilt nodes start fully lit; keep a traced lineage's dimming.
    const traced = focusRef.current.lineage;
    if (traced !== null) {
      const emphasis = nodes.geometry.getAttribute("emphasis") as THREE.BufferAttribute;
      const values = emphasis.array as Float32Array;
      values.fill(0);
      for (const node of traced.nodes) values[node] = 1;
    }
    stage.content.add(nodes);

    // Where each island finished: the old app's gold diamonds, drawn on top so a
    // marker is never lost inside the cloud. The one holding the best fitness in
    // the run is drawn larger.
    const finals: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if ((payload.flags[i]! & NodeFlag.FinalBest) === 0) continue;
      if (hiddenIslands.has(payload.islandId[i]!)) continue;
      finals.push(i);
    }
    if (finals.length > 0) {
      const gold = cssToRgb(palette.islandBest);
      const positions = new Float32Array(finals.length * 3);
      const colours = new Float32Array(finals.length * 3);
      const sizes = new Float32Array(finals.length);
      const shapes = new Float32Array(finals.length).fill(1);
      finals.forEach((node, slot) => {
        positions.set(fitted.subarray(node * 3, node * 3 + 3), slot * 3);
        colours.set(gold, slot * 3);
        sizes[slot] = (payload.fitness[node] === bestFitness ? 24 : 17) * Math.sqrt(nodeScale);
      });
      stage.content.add(pointCloud(positions, colours, sizes, shapes, pixelRatio, true, palette));
    }
    pickRef.current = {
      positions: fitted,
      sizes: nodeSizes,
      finals: finals.map((index) => ({
        index,
        size: (payload.fitness[index] === bestFitness ? 24 : 17) * Math.sqrt(nodeScale),
      })),
    };

    // Trajectory edges. Ordinary blending, low opacity, so dense regions settle
    // at the island's colour instead of burning to white. Every edge is drawn;
    // weight lifts an edge's alpha and the intensity control scales them all.
    const count = payload.edgeSource.length;
    const edgePositions = new Float32Array(count * 6);
    const edgeColours = new Float32Array(count * 8);
    let written = 0;
    const tint = new THREE.Color();
    for (let e = 0; e < count; e += 1) {
      const a = payload.edgeSource[e]!;
      const b = payload.edgeTarget[e]!;
      const island = payload.islandId[a]!;
      if (hiddenIslands.has(island)) continue;
      tint.set(palette.islands[island % palette.islands.length]!);
      const alpha = Math.min(1, 1 + 0.9 * (payload.edgeWeight[e]! - 1));
      for (let end = 0; end < 2; end += 1) {
        const node = end === 0 ? a : b;
        edgePositions.set(fitted.subarray(node * 3, node * 3 + 3), written * 6 + end * 3);
        edgeColours.set([tint.r, tint.g, tint.b, alpha], written * 8 + end * 4);
      }
      written += 1;
    }
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions.subarray(0, written * 6), 3));
    edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColours.subarray(0, written * 8), 4));
    const edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      opacity: edgeOpacity(palette, edgeIntensity, lineageOnRef.current),
    });
    edgeMaterialRef.current = edgeMaterial;
    stage.content.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    // Migrations stay a separate layer in the reserved magenta.
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
      new THREE.LineBasicMaterial({ color: palette.migration, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    migrations.renderOrder = 5;
    migrations.visible = showMigrations;
    migrationRef.current = migrations;
    stage.content.add(migrations);

    stage.dirty = true;
    // edgeIntensity and showMigrations are applied by their own cheap effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, fitted, hiddenIslands, nodeScale, n, palette, bestFitness, colourBy, fitnessShade]);

  useEffect(() => {
    const material = edgeMaterialRef.current;
    const stage = stageRef.current;
    if (material === null || stage === null) return;
    material.opacity = edgeOpacity(palette, edgeIntensity, lineageOnRef.current);
    stage.dirty = true;
  }, [edgeIntensity, palette]);

  // ---- selection: ring, neighbour edges, traced lineage ---------------------
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    disposeChildren(stage.focus);
    const pixelRatio = stage.renderer.getPixelRatio();
    const at = (i: number): [number, number, number] => [fitted[i * 3]!, fitted[i * 3 + 1]!, fitted[i * 3 + 2]!];
    const lines = (pairs: number[], colour: number, opacity: number, order: number) => {
      if (pairs.length === 0) return;
      const positions = new Float32Array(pairs.length * 3);
      pairs.forEach((node, k) => positions.set(at(node), k * 3));
      const segments = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(positions, 3)),
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity, depthTest: false }),
      );
      segments.renderOrder = order;
      stage.focus.add(segments);
    };

    const { selected, lineage } = focus;
    if (lineage !== null) {
      lines(Array.from(lineage.edges), palette.ancestry, 0.85, 8);
      lines(Array.from(lineage.crossings), palette.migration, 0.9, 8);
    }

    if (selected !== null && selected < n) {
      const steps: number[] = [];
      const crossings: number[] = [];
      for (const parent of focus.parents) (parent.via === "migration" ? crossings : steps).push(parent.index, selected);
      const out: number[] = [];
      for (const child of focus.children) out.push(selected, child.index);
      if (lineage === null) lines(steps, palette.ancestry, 0.95, 9);
      lines(crossings, palette.migration, 0.95, 9);
      lines(out, palette.descendants, 0.8, 9);

      const ring = pointCloud(
        new Float32Array(at(selected)),
        new Float32Array(cssToRgb(palette.focus)),
        new Float32Array([26]),
        new Float32Array([2]),
        pixelRatio,
        true,
        palette,
      );
      ring.renderOrder = 12;
      stage.focus.add(ring);
    }

    // Dim everything outside a traced lineage, so the ancestry reads on its own.
    lineageOnRef.current = lineage !== null;
    const nodes = nodesRef.current;
    const emphasis = nodes?.geometry.getAttribute("emphasis") as THREE.BufferAttribute | undefined;
    if (emphasis !== undefined) {
      const values = emphasis.array as Float32Array;
      if (lineage === null) values.fill(1);
      else {
        values.fill(0);
        for (const node of lineage.nodes) values[node] = 1;
      }
      emphasis.needsUpdate = true;
    }
    if (edgeMaterialRef.current !== null) {
      edgeMaterialRef.current.opacity = edgeOpacity(palette, edgeIntensity, lineage !== null);
    }
    stage.dirty = true;
    // edgeIntensity is read for the dimmed opacity only; its own effect handles changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, fitted, palette, n, payload]);

  // ---- actions the page can call ---------------------------------------------
  useEffect(() => {
    apiRef.current = {
      capture: () => {
        const stage = stageRef.current;
        if (stage === null) return null;
        // Render and read in the same task, before the browser clears the buffer.
        stage.renderer.render(stage.scene, stage.dims === 3 ? stage.perspective : stage.orthographic);
        return stage.renderer.domElement.toDataURL("image/png");
      },
      centreOn: (index: number) => {
        const stage = stageRef.current;
        if (stage === null || index >= n) return;
        const target = new THREE.Vector3(fitted[index * 3]!, fitted[index * 3 + 1]!, fitted[index * 3 + 2]!);
        if (stage.dims === 3) {
          const shift = target.clone().sub(stage.orbit.target);
          stage.perspective.position.add(shift);
          stage.orbit.target.copy(target);
          stage.orbit.update();
        } else {
          stage.pan.target.set(target.x, target.y, 0);
          stage.orthographic.position.set(target.x, target.y, 10);
          stage.pan.update();
        }
        stage.dirty = true;
      },
    };
    return () => { apiRef.current = null; };
  }, [apiRef, fitted, n]);

  useEffect(() => {
    const migrations = migrationRef.current;
    const stage = stageRef.current;
    if (migrations === null || stage === null) return;
    migrations.visible = showMigrations;
    stage.dirty = true;
  }, [showMigrations]);

  return <div ref={hostRef} style={{ position: "absolute", inset: "0" }} />;
}

// ---------------------------------------------------------------------------
// Nodes: shaded balls and diamonds from a point shader
// ---------------------------------------------------------------------------

const POINT_VERTEX = /* glsl */ `
  attribute vec3 colour;
  attribute float size;
  attribute float shape;
  attribute float emphasis;
  uniform float pixelRatio;
  uniform vec3 ground;
  varying vec3 vColour;
  varying float vShape;
  varying float vSize;
  void main() {
    // Nodes outside a traced lineage fade most of the way into the ground.
    vColour = mix(ground, colour, 0.18 + 0.82 * emphasis);
    vShape = shape;
    vSize = size * pixelRatio;
    gl_PointSize = vSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/*
 * Colours arrive and leave as sRGB: this material writes straight to the
 * canvas, so what is in palette.ts is exactly what appears on screen.
 */
const POINT_FRAGMENT = /* glsl */ `
  varying vec3 vColour;
  varying float vShape;
  varying float vSize;
  void main() {
    if (vSize < 0.5) discard;
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    p.y = -p.y;
    float edge = vShape < 0.5 || vShape > 1.5 ? length(p) : abs(p.x) + abs(p.y);
    if (edge > 1.0) discard;

    // Shape 2 is the selection ring: flat, no shading.
    if (vShape > 1.5) {
      if (edge < 0.66) discard;
      gl_FragColor = vec4(vColour, 1.0);
      return;
    }

    // About one device pixel of edge, in a darker shade of the node's own
    // colour: enough to separate overlapping nodes without turning a small one
    // into a hollow ring.
    if (edge > 1.0 - 2.0 / max(vSize, 1.0)) {
      gl_FragColor = vec4(vColour * 0.42, 1.0);
      return;
    }

    // Light from the upper left, as if each point were a small sphere.
    vec3 normal = vShape < 0.5
      ? vec3(p, sqrt(max(0.0, 1.0 - dot(p, p))))
      : normalize(vec3(p * 0.6, 1.0));
    vec3 light = normalize(vec3(-0.45, 0.55, 0.75));
    float diffuse = max(dot(normal, light), 0.0);
    float shine = pow(max(dot(reflect(-light, normal), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
    vec3 colour = vColour * (0.52 + 0.58 * diffuse) + vec3(0.22) * shine;
    gl_FragColor = vec4(min(colour, vec3(1.0)), 1.0);
  }
`;

function pointCloud(
  positions: Float32Array,
  colours: Float32Array,
  sizes: Float32Array,
  shapes: Float32Array,
  pixelRatio: number,
  onTop: boolean,
  palette: ScenePalette,
): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("colour", new THREE.BufferAttribute(colours, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("shape", new THREE.BufferAttribute(shapes, 1));
  geometry.setAttribute("emphasis", new THREE.BufferAttribute(new Float32Array(sizes.length).fill(1), 1));
  const material = new THREE.ShaderMaterial({
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    uniforms: {
      pixelRatio: { value: pixelRatio },
      ground: { value: new THREE.Vector3(...cssToRgb(`#${palette.canvas.toString(16).padStart(6, "0")}`)) },
    },
    depthTest: !onTop,
  });
  const points = new THREE.Points(geometry, material);
  if (onTop) points.renderOrder = 10;
  return points;
}

/** Trajectory edges, dimmed to a quarter behind a traced lineage. */
function edgeOpacity(palette: ScenePalette, intensity: number, lineageOn: boolean): number {
  return Math.min(1, palette.edgeOpacity * intensity * (lineageOn ? 0.25 : 1));
}

/** Viridis, the colour map the Streamlit app used for fitness. t = 1 is the best. */
const VIRIDIS = [
  [0x44, 0x01, 0x54], [0x48, 0x28, 0x78], [0x3e, 0x49, 0x89], [0x31, 0x68, 0x8e], [0x26, 0x82, 0x8e],
  [0x1f, 0x9e, 0x89], [0x35, 0xb7, 0x79], [0x6e, 0xce, 0x58], [0xb5, 0xde, 0x2b], [0xfd, 0xe7, 0x25],
] as const;
function viridis(t: number): [number, number, number] {
  const x = Math.min(Math.max(t, 0), 1) * (VIRIDIS.length - 1);
  const i = Math.min(Math.floor(x), VIRIDIS.length - 2);
  const f = x - i;
  const a = VIRIDIS[i]!;
  const b = VIRIDIS[i + 1]!;
  return [
    (a[0] + (b[0] - a[0]) * f) / 255,
    (a[1] + (b[1] - a[1]) * f) / 255,
    (a[2] + (b[2] - a[2]) * f) / 255,
  ];
}

/** "#RRGGBB" to [r, g, b] in 0..1, left in sRGB. */
function cssToRgb(css: string): [number, number, number] {
  const value = Number.parseInt(css.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// ---------------------------------------------------------------------------
// The plot box
// ---------------------------------------------------------------------------

const GRID_DIVISIONS = 6;

/**
 * Two candidate walls per axis, one at each end. `orientBox` shows the one on
 * the far side of the camera, so the grid is always behind the data.
 */
function buildBox(palette: ScenePalette, axisLabels: readonly [string, string, string]): BoxParts {
  const group = new THREE.Group();
  const walls: THREE.Object3D[][] = [[], [], []];

  const fill = new THREE.MeshBasicMaterial({
    color: palette.wall,
    transparent: true,
    opacity: palette.wallOpacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const gridMaterial = new THREE.LineBasicMaterial({ color: palette.grid });
  const borderMaterial = new THREE.LineBasicMaterial({ color: palette.rule });

  for (let axis = 0; axis < 3; axis += 1) {
    for (let side = 0; side < 2; side += 1) {
      const wall = new THREE.Group();

      const plane = new THREE.Mesh(new THREE.PlaneGeometry(2 * HALF, 2 * HALF), fill);
      plane.renderOrder = -2;
      wall.add(plane);

      const lines: number[] = [];
      for (let k = 1; k < GRID_DIVISIONS; k += 1) {
        const t = -HALF + (2 * HALF * k) / GRID_DIVISIONS;
        lines.push(t, -HALF, 0, t, HALF, 0, -HALF, t, 0, HALF, t, 0);
      }
      const grid = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(lines, 3)),
        gridMaterial,
      );
      grid.renderOrder = -1;
      wall.add(grid);

      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(2 * HALF, 2 * HALF)),
        borderMaterial,
      );
      border.renderOrder = -1;
      wall.add(border);

      // A wall is built in the XY plane; turn it to face its axis.
      const offset = side === 0 ? -HALF : HALF;
      if (axis === 0) {
        wall.rotation.y = Math.PI / 2;
        wall.position.x = offset;
      } else if (axis === 1) {
        wall.rotation.x = Math.PI / 2;
        wall.position.y = offset;
      } else {
        wall.position.z = offset;
      }
      walls[axis]!.push(wall);
      group.add(wall);
    }
  }

  const titles = axisLabels.map((text) => {
    const sprite = label(text, palette.label);
    group.add(sprite);
    return sprite;
  });

  return { group, walls, titles };
}

/** Show the walls behind the data and put the axis titles on the near edges. */
function orientBox(box: BoxParts, camera: THREE.Vector3): void {
  const side = [camera.x >= 0 ? 1 : -1, camera.y >= 0 ? 1 : -1, camera.z >= 0 ? 1 : -1] as const;
  for (let axis = 0; axis < 3; axis += 1) {
    // Far wall: at -1 when the camera is on the + side.
    const far = side[axis]! > 0 ? 0 : 1;
    box.walls[axis]![far]!.visible = true;
    box.walls[axis]![1 - far]!.visible = false;
  }
  const [xTitle, yTitle, zTitle] = box.titles;
  const out = 1.34 * HALF;
  xTitle?.position.set(0, side[1] * out, -side[2] * HALF);
  yTitle?.position.set(side[0] * out, 0, -side[2] * HALF);
  zTitle?.position.set(side[0] * out, -side[1] * out, 0);
}

/** A camera-facing text label, drawn over everything so it is never hidden. */
function label(text: string, colour: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (context !== null) {
    context.font = '500 36px Archivo, "Segoe UI", sans-serif';
    context.fillStyle = colour;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, 320, 48);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }),
  );
  sprite.renderOrder = 20;
  sprite.scale.set(0.9, 0.135, 1);
  return sprite;
}

function disposeChildren(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    disposeTree(child);
    group.remove(child);
  }
}

function disposeTree(root: THREE.Object3D): void {
  const seen = new Set<unknown>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry !== undefined && !seen.has(mesh.geometry)) {
      seen.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    const list = Array.isArray(material) ? material : material !== undefined ? [material] : [];
    for (const m of list) {
      if (seen.has(m)) continue;
      seen.add(m);
      (m as THREE.SpriteMaterial).map?.dispose();
      m.dispose();
    }
  });
}
