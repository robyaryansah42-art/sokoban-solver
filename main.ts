// sokoban-solver: a push-optimal Sokoban solver for make.fun's sokoban-solver-01
// bounty ("Build the best Sokoban solver, 21 November 2026").
//
// The levels are a one-square hallway with independent rooms off it: a box pushed
// out of a room through its door can never be pushed back, so every box stays in
// its own room and the level's push-optimum P* is the sum of the rooms' optima.
// This solver therefore splits each level into rooms, solves every room on its
// own with an A* search over pushes, and joins the room solutions with the
// player's walk through the hallway.
//
// The search is push-optimal: its heuristic, the cheapest assignment of boxes to
// goals over wall-only walking distances, never overestimates the pushes left, so
// the first solved state the search pops is optimal for its room. Two prunings
// keep the search small: a box on a dead square (one from which no sequence of
// pushes, ignoring the other boxes, reaches any goal) and a frozen 2x2 block of
// walls and boxes holding a box off its goal can never lead to a solution.
//
// Everything is deterministic: the search is bounded by counted state expansions,
// never by the clock, and every tie breaks the same way on every run, so two
// executions write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in state expansions (never the clock: a run cut off by
// the clock would answer differently from one execution to the next).
const ROOM_EXPANSION_CAP = 600_000;
const RUN_EXPANSION_CAP = 5_000_000;

/** One of the four moves: its step, its walk letter and its push letter. */
interface Step {
  dx: number;
  dy: number;
  walk: string;
  push: string;
}
const STEPS: Step[] = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

/** A level parsed from XSB text: squares are row-major indices, y * w + x. */
interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** The run's shared work budget. */
interface Budget {
  used: number;
  limit: number;
}

/** One room of a level: its boxes and its goals, each sorted. */
interface Room {
  boxes: number[];
  goals: number[];
}

/** Parse XSB (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch === '#') continue;
      const i = y * w + x;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  // The outer frame is wall whatever the text shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares from which a box can still be pushed onto some goal, found by
 * pulling backwards from the goals: a box on y can be pushed onto x exactly when
 * the player can stand on y - d, so y is live whenever x is live and both y and
 * y - d are open floor. A box on any other square is dead: no push sequence,
 * ignoring the other boxes, brings it to a goal.
 */
function liveSquares(w: number, wall: Uint8Array, goals: number[]): Uint8Array {
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const s of STEPS) {
      const d = s.dy * w + s.dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Walking distances from every square to one goal, around walls alone (boxes ignored); -1 where unreachable. */
function distancesTo(w: number, wall: Uint8Array, goal: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue: number[] = [goal];
  dist[goal] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    for (const s of STEPS) {
      const q = p + s.dy * w + s.dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p]! + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** Every ordering of 0..n-1, for the box-to-goal assignment. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const arr = Array.from({ length: n }, (_, i) => i);
  const gen = (k: number): void => {
    if (k === 1) {
      out.push(arr.slice());
      return;
    }
    for (let i = 0; i < k; i++) {
      gen(k - 1);
      const j = k % 2 === 1 ? 0 : i;
      const tmp = arr[j]!;
      arr[j] = arr[k - 1]!;
      arr[k - 1] = tmp;
    }
  };
  gen(n);
  return out;
}

/**
 * Split a level into its rooms: cut the hallway row's dead squares out of the
 * floor (a box there reaches no goal), and each connected part left that holds
 * boxes is a room. Returns null when the level is no set of rooms (a box in the
 * hallway, a goal cut off, or a part whose boxes and goals do not match).
 */
function splitRooms(board: Board): Room[] | null {
  const { w, h, wall, goals, boxes, player } = board;
  const live = liveSquares(w, wall, goals);
  const size = w * h;
  const cut = new Uint8Array(size);
  const hallRow = Math.floor(player / w);
  for (let x = 0; x < w; x++) {
    const i = hallRow * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  if (goals.some((g) => cut[g])) return null;
  const part = new Int32Array(size).fill(-1);
  const rooms: Room[] = [];
  const stack: number[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const id = rooms.length;
    rooms.push({ boxes: [], goals: [] });
    part[s] = id;
    stack.length = 0;
    stack.push(s);
    while (stack.length > 0) {
      const p = stack.pop()!;
      for (const st of STEPS) {
        const q = p + st.dy * w + st.dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = id;
          stack.push(q);
        }
      }
    }
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) rooms[part[g]!]!.goals.push(g);
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The shortest walk from `from` to `to` around walls and boxes, in lowercase letters. */
function walkTo(w: number, wall: Uint8Array, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const s of STEPS) {
      const q = p + s.dy * w + s.dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = s.walk;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let out = '';
  for (let p = to; p !== from; p = prev[p]!) out = how[p]! + out;
  return out;
}

/**
 * The push-optimal solution of one room (or of a whole level, when it is no set
 * of rooms): A* over pushes. A state is the boxes' squares, sorted, plus the
 * player's reachable region, named by its lowest square; a push costs 1, and the
 * estimate is the cheapest assignment of boxes to goals over wall-only
 * distances, which no solution can beat, so the first solved state popped is
 * optimal. Returns the moves (lowercase walks, uppercase pushes) and the push
 * count, or null when the work budget runs out.
 */
function solvePushes(
  w: number,
  h: number,
  wall: Uint8Array,
  goals: number[],
  boxes0: number[],
  player0: number,
  budget: Budget,
): { moves: string; pushes: number } | null {
  const size = w * h;
  const n = boxes0.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(w, wall, goals);
  if (boxes0.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goalSet[b]);

  // The heuristic: the cheapest box-to-goal assignment (up to four boxes, every
  // ordering tried); past that, each box's nearest goal, summed. Both are
  // admissible, so the search stays optimal. Unreachable pairings score -1.
  const distByGoal = goals.map((g) => distancesTo(w, wall, g));
  const orders = n <= 4 ? permutations(n) : null;
  const hCache = new Map<number | string, number>();

  // State keys as digits in base `size` while they stay exact; a string key past
  // that (only a whole level with many boxes ever gets there).
  const numeric = Math.pow(size, n + 1) < Number.MAX_SAFE_INTEGER;
  const boxesKey = (boxes: number[]): number | string => {
    if (!numeric) return boxes.join(',');
    let k = 0;
    for (const b of boxes) k = k * size + b;
    return k;
  };
  const stateKey = (boxes: number[], low: number): number | string => {
    if (!numeric) return `${low}:${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };
  const heuristic = (boxes: number[]): number => {
    const ck = boxesKey(boxes);
    const hit = hCache.get(ck);
    if (hit !== undefined) return hit;
    let best = Infinity;
    if (orders !== null) {
      for (const order of orders) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = distByGoal[order[i]!]![boxes[i]!]!;
          if (d < 0) {
            sum = Infinity;
            break;
          }
          sum += d;
        }
        if (sum < best) best = sum;
      }
    } else {
      let sum = 0;
      for (const b of boxes) {
        let near = Infinity;
        for (const dist of distByGoal) {
          const d = dist[b]!;
          if (d >= 0 && d < near) near = d;
        }
        if (!isFinite(near)) {
          sum = Infinity;
          break;
        }
        sum += near;
      }
      best = sum;
    }
    hCache.set(ck, best);
    return best;
  };

  // Flood fills share two stamp arrays: one marks the region the player reaches
  // from a state's square (which pushes it can make), the other the region after
  // a push (the next state's canonical square).
  const occupied = new Uint8Array(size);
  const reachMark = new Int32Array(size);
  const lowMark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const fillFrom = (from: number, mark: Int32Array, stampHere: number): number => {
    let low = from;
    let top = 0;
    stack[top++] = from;
    mark[from] = stampHere;
    while (top > 0) {
      const p = stack[--top]!;
      if (p < low) low = p;
      for (const s of STEPS) {
        const q = p + s.dy * w + s.dx;
        if (!wall[q] && !occupied[q] && mark[q] !== stampHere) {
          mark[q] = stampHere;
          stack[top++] = q;
        }
      }
    }
    return low;
  };

  // Whether the box just pushed onto `t` sits in a frozen 2x2 block: four
  // squares of walls and boxes, one of them a box off its goal. Nothing in such
  // a block can ever move again.
  const frozen = (t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!((wall[a] || occupied[a]) && (wall[b] || occupied[b]) && (wall[c] || occupied[c]) && (wall[d] || occupied[d]))) continue;
      if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b]) || (occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d])) return true;
    }
    return false;
  };

  // The states, in the order found: their boxes, the player's square after the
  // push that made them, their parent, the push itself, and their push count.
  const sBoxes: number[][] = [boxes0.slice()];
  const sPlayer: number[] = [player0];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sPushes: number[] = [0];
  const sKey: (number | string)[] = [];
  const best = new Map<number | string, number>();

  // The open list: a binary heap on (f, h, insertion order), so ties always
  // break the same way.
  const heap: [number, number, number, number][] = [];
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  for (const b of boxes0) occupied[b] = 1;
  const startLow = fillFrom(player0, lowMark, ++stamp);
  for (const b of boxes0) occupied[b] = 0;
  const h0 = heuristic(boxes0);
  if (!isFinite(h0)) return null;
  const key0 = stateKey(boxes0, startLow);
  sKey.push(key0);
  best.set(key0, 0);
  let order = 0;
  heapPush([h0, h0, order++, 0]);
  if (solved(boxes0)) return { moves: '', pushes: 0 };

  let expanded = 0;
  while (heap.length > 0) {
    const [, , , idx] = heapPop();
    const g = sPushes[idx]!;
    if (best.get(sKey[idx]!) !== g) continue; // a better path to this state came later
    const boxes = sBoxes[idx]!;
    if (solved(boxes)) {
      // Rebuild the push path, then the moves: walk to each push's square, push.
      const pushes: [number, number][] = [];
      for (let s = idx; s > 0; s = sParent[s]!) pushes.push([sFrom[s]!, sTo[s]!]);
      pushes.reverse();
      let moves = '';
      let player = player0;
      let current = boxes0.slice();
      for (const [from, to] of pushes) {
        const d = to - from;
        for (const b of current) occupied[b] = 1;
        moves += walkTo(w, wall, occupied, player, from - d);
        for (const b of current) occupied[b] = 0;
        moves += STEPS.find((s) => s.dy * w + s.dx === d)!.push;
        player = from;
        current = current.map((b) => (b === from ? to : b)).sort((a, b) => a - b);
      }
      return { moves, pushes: pushes.length };
    }
    if (++expanded > ROOM_EXPANSION_CAP || budget.used >= budget.limit) return null;
    budget.used++;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    fillFrom(sPlayer[idx]!, reachMark, here);
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      for (const s of STEPS) {
        const d = s.dy * w + s.dx;
        const t = b + d;
        if (reachMark[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozen(t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b) => a - b);
        const low = fillFrom(b, lowMark, ++stamp);
        const key = stateKey(next, low);
        const ng = g + 1;
        const prev = best.get(key);
        let nh = Infinity;
        if (prev === undefined || prev > ng) nh = heuristic(next);
        occupied[t] = 0;
        occupied[b] = 1;
        if (prev !== undefined && prev <= ng) continue;
        if (!isFinite(nh)) continue;
        best.set(key, ng);
        const nidx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(idx);
        sFrom.push(b);
        sTo.push(t);
        sPushes.push(ng);
        sKey.push(key);
        heapPush([ng + nh, nh, order++, nidx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  return null;
}

/**
 * One level, solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's. Returns '' when
 * a room's search runs out of budget (still a valid, if scoreless, answer).
 */
function solveLevel(text: string, budget: Budget): string {
  const board = parseLevel(text);
  const rooms = splitRooms(board);
  if (rooms === null) {
    const whole = solvePushes(board.w, board.h, board.wall, board.goals, board.boxes, board.player, budget);
    return whole === null ? '' : whole.moves;
  }
  const done = rooms.map(() => false);
  const current = rooms.map((r) => r.boxes.slice());
  let player = board.player;
  let moves = '';
  for (let ri = 0; ri < rooms.length; ri++) {
    const wall = board.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      for (const b of done[oj] ? rooms[oj]!.goals : current[oj]!) wall[b] = 1;
    }
    const room = rooms[ri]!;
    const solved = solvePushes(board.w, board.h, wall, room.goals, current[ri]!, player, budget);
    if (solved === null) return '';
    moves += solved.moves;
    for (const ch of solved.moves) {
      const c = ch.toLowerCase();
      player += c === 'u' ? -board.w : c === 'd' ? board.w : c === 'l' ? -1 : 1;
    }
    done[ri] = true;
    current[ri] = room.goals.slice();
  }
  return moves;
}

const budget: Budget = { used: 0, limit: RUN_EXPANSION_CAP };
for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), budget);
  } catch (err) {
    console.error(`sokoban-solver: ${id}: ${err instanceof Error ? err.message : String(err)}`);
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
