/**
 * Minimal typings for `d3-force-3d`, which ships none.
 *
 * Only the surface DriftLayout actually uses. Deliberately narrow: a fuller
 * declaration would be guesswork about parts we never call.
 */
declare module "d3-force-3d" {
  export interface Simulation<TNode> {
    force(name: string, force: unknown): Simulation<TNode>;
    tick(iterations?: number): Simulation<TNode>;
    stop(): Simulation<TNode>;
    nodes(): TNode[];
  }

  export interface ManyBodyForce {
    strength(value: number): ManyBodyForce;
    theta(value: number): ManyBodyForce;
    distanceMax(value: number): ManyBodyForce;
  }

  export interface LinkForce<TNode> {
    id(accessor: (node: TNode) => number | string): LinkForce<TNode>;
    distance(value: number): LinkForce<TNode>;
    strength(value: number): LinkForce<TNode>;
  }

  export interface CollideForce {
    strength(value: number): CollideForce;
    radius(value: number): CollideForce;
  }

  export interface PositionForce {
    strength(value: number): PositionForce;
  }

  export function forceSimulation<TNode>(
    nodes: TNode[],
    numDimensions?: number,
  ): Simulation<TNode>;
  export function forceManyBody(): ManyBodyForce;
  export function forceCollide(radius?: number): CollideForce;
  export function forceLink<TNode>(links: unknown[]): LinkForce<TNode>;
  export function forceX(x?: number): PositionForce;
  export function forceY(y?: number): PositionForce;
  export function forceZ(z?: number): PositionForce;
}
