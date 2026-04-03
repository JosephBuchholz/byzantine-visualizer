export interface Point {
  x: number;
  y: number;
}

export function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

export interface StageObject {
  stageWidth: number;
  stageHeight: number;
  stagePosition: Point;
  stageScale: number;
}
