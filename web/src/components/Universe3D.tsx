import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Edges, Grid, Line, OrbitControls, RoundedBox } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  LayoutGrid,
  LocateFixed,
  Minus,
  Plus,
  Tags,
} from "lucide-react";
import type { Certainty, GraphEdge, GraphNode } from "../../../shared/types";
import { CERTAINTY_COLOR, KIND_COLOR, KIND_LABEL, LANGUAGE_COLOR, truncate } from "../lib/constants";
import { layout3D, type Cluster3D, type Layout3DKind, type Positioned3D } from "../lib/threeLayout";
import { useI18n } from "../i18n";

interface Universe3DProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onOpenFile: (filePath: string) => void;
  onOpenFolder: (folderPath: string) => void;
  truncated?: boolean;
}

type EdgeMode = "architecture" | "dependency" | "flow";

interface VisibleEdge extends GraphEdge {
  count: number;
}

const LAYOUT_OPTIONS: { id: Layout3DKind; label: string }[] = [
  { id: "hybrid", label: "Hybrid" },
  { id: "hierarchical", label: "Hierarchical" },
  { id: "clustered", label: "Clustered" },
  { id: "force", label: "Force" },
];

const EDGE_OPTIONS: { id: EdgeMode; label: string }[] = [
  { id: "architecture", label: "Architecture" },
  { id: "dependency", label: "Dependency" },
  { id: "flow", label: "Execution flow" },
];

function edgeAllowed(mode: EdgeMode, kind: GraphEdge["kind"]): boolean {
  if (mode === "architecture") {
    return [
      "CONTAINS",
      "IMPORTS",
      "ROUTES_TO",
      "READS_FROM",
      "WRITES_TO",
      "PUBLISHES",
      "SUBSCRIBES_TO",
      "MAPS_TO",
      "RELATES_TO",
    ].includes(kind);
  }
  if (mode === "dependency") {
    return ["IMPORTS", "CALLS", "EXTENDS", "IMPLEMENTS", "ROUTES_TO"].includes(kind);
  }
  return ["CALLS", "ROUTES_TO", "READS_FROM", "WRITES_TO", "PUBLISHES", "SUBSCRIBES_TO"].includes(kind);
}

function certaintyRank(certainty: Certainty): number {
  return certainty === "confirmed" ? 0 : certainty === "inferred" ? 1 : 2;
}

function worstCertainty(values: Certainty[]): Certainty {
  return values.reduce<Certainty>(
    (worst, value) => (certaintyRank(value) > certaintyRank(worst) ? value : worst),
    "confirmed",
  );
}

function makeLabelTexture(label: string, color: string, selected: boolean, connected: boolean): THREE.CanvasTexture {
  const text = truncate(label, 32);
  const dpr = 2;
  const fontSize = 34;
  const paddingX = 20;
  const height = 72;
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = `600 ${fontSize}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const width = Math.ceil(measure.measureText(text).width + paddingX * 2);
  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const context = canvas.getContext("2d")!;
  context.scale(dpr, dpr);

  context.beginPath();
  context.roundRect(0.5, 0.5, width - 1, height - 1, 14);
  context.fillStyle = selected ? "rgba(8, 15, 25, 0.97)" : connected ? "rgba(8, 14, 23, 0.9)" : "rgba(7, 12, 19, 0.8)";
  context.fill();
  context.strokeStyle = selected ? `${color}cc` : `${color}55`;
  context.lineWidth = selected ? 2 : 1.2;
  context.stroke();
  context.font = `600 ${fontSize}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = selected ? "#ffffff" : color;
  context.fillText(text, width / 2, height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.userData.worldWidth = Math.min(2.6, Math.max(1.05, width / 200));
  texture.userData.aspect = height / width;
  return texture;
}

function LabelSprite({
  node,
  color,
  selected,
  connected,
  y,
  onSelect,
}: {
  node: GraphNode;
  color: string;
  selected: boolean;
  connected: boolean;
  y: number;
  onSelect: (id: string) => void;
}) {
  const texture = useMemo(
    () => makeLabelTexture(node.label, color, selected, connected),
    [node.label, color, selected, connected],
  );
  useEffect(() => () => texture.dispose(), [texture]);
  const width = texture.userData.worldWidth as number;
  const height = width * (texture.userData.aspect as number);
  const spriteRef = useRef<THREE.Sprite>(null);
  const worldPosition = useMemo(() => new THREE.Vector3(), []);
  const { camera } = useThree();

  useFrame(() => {
    if (!spriteRef.current) return;
    spriteRef.current.getWorldPosition(worldPosition);
    const distance = camera.position.distanceTo(worldPosition);
    const factor = Math.max(0.55, Math.min(2.2, distance / 11));
    spriteRef.current.scale.set(width * factor, height * factor, 1);
  });

  return (
    <sprite
      ref={spriteRef}
      position={[0, y, 0]}
      scale={[width, height, 1]}
      renderOrder={100}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.id);
      }}
    >
      <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} />
    </sprite>
  );
}

function CameraRig({ center, radius }: { center: [number, number, number]; radius: number }) {
  const { camera } = useThree();
  const centerKey = center.join("|");

  useEffect(() => {
    camera.position.set(center[0] + radius * 1.35, center[1] + radius * 0.8, center[2] + radius * 1.7);
    camera.lookAt(center[0], center[1], center[2]);
    camera.near = 0.1;
    camera.far = radius * 18;
    camera.updateProjectionMatrix();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerKey, radius, camera]);

  return null;
}

type NavCommand =
  | { type: "pan"; horizontal: number; vertical: number }
  | { type: "zoom"; factor: number }
  | { type: "reset" };

const NAV_EVENT = "cie:3d-nav";

function sendNavCommand(command: NavCommand): void {
  window.dispatchEvent(new CustomEvent<NavCommand>(NAV_EVENT, { detail: command }));
}

function NavigationBridge({
  center,
  radius,
}: {
  center: [number, number, number];
  radius: number;
}) {
  const { camera } = useThree();
  const controls = useThree((state) => state.controls) as any;
  const centerKey = center.join("|");
  const desiredPosition = useRef(new THREE.Vector3());
  const desiredTarget = useRef(new THREE.Vector3());
  const animating = useRef(false);

  useEffect(() => {
    if (!controls) return;

    desiredPosition.current.copy(camera.position);
    desiredTarget.current.copy(controls.target);
    animating.current = false;

    const pan = (horizontal: number, vertical: number) => {
      const distance = desiredPosition.current.distanceTo(desiredTarget.current);
      const step = Math.max(0.28, distance * 0.055);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      const delta = right.multiplyScalar(horizontal * step).add(up.multiplyScalar(vertical * step));
      desiredPosition.current.add(delta);
      desiredTarget.current.add(delta);
      animating.current = true;
    };

    const zoom = (factor: number) => {
      const direction = desiredPosition.current.clone().sub(desiredTarget.current);
      const distance = direction.length();
      const next = THREE.MathUtils.clamp(
        distance * factor,
        typeof controls.minDistance === "number" ? controls.minDistance : 1.8,
        typeof controls.maxDistance === "number" ? controls.maxDistance : radius * 7,
      );
      direction.setLength(next);
      desiredPosition.current.copy(desiredTarget.current).add(direction);
      animating.current = true;
    };

    const reset = () => {
      desiredPosition.current.set(
        center[0] + radius * 1.35,
        center[1] + radius * 0.8,
        center[2] + radius * 1.7,
      );
      desiredTarget.current.set(center[0], center[1], center[2]);
      animating.current = true;
    };

    const handler = (event: Event) => {
      const command = (event as CustomEvent<NavCommand>).detail;
      if (!command) return;
      if (command.type === "pan") pan(command.horizontal, command.vertical);
      else if (command.type === "zoom") zoom(command.factor);
      else reset();
    };

    window.addEventListener(NAV_EVENT, handler);
    return () => window.removeEventListener(NAV_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, controls, centerKey, radius]);

  useFrame((_, delta) => {
    if (!animating.current) return;
    if (!controls) return;

    const easing = 1 - Math.exp(-Math.min(0.06, delta) * 11);
    camera.position.lerp(desiredPosition.current, easing);
    controls.target.lerp(desiredTarget.current, easing);
    controls.update();

    if (
      camera.position.distanceTo(desiredPosition.current) < 0.025 &&
      controls.target.distanceTo(desiredTarget.current) < 0.025
    ) {
      camera.position.copy(desiredPosition.current);
      controls.target.copy(desiredTarget.current);
      controls.update();
      animating.current = false;
    }
  });

  return null;
}

function LodController({
  center,
  radius,
  enabled,
  onDepth,
}: {
  center: [number, number, number];
  radius: number;
  enabled: boolean;
  onDepth: (depth: number) => void;
}) {
  const { camera } = useThree();
  const last = useRef(0);
  const centerVector = useMemo(() => new THREE.Vector3(center[0], center[1], center[2]), [center]);

  useFrame(({ clock }) => {
    if (!enabled) return;
    if (clock.elapsedTime - last.current < 0.22) return;
    last.current = clock.elapsedTime;
    const ratio = camera.position.distanceTo(centerVector) / Math.max(1, radius);
    const depth = ratio > 1.55 ? 1 : ratio > 1.12 ? 2 : ratio > 0.78 ? 3 : 4;
    onDepth(depth);
  });

  return null;
}

function ProjectCore({ color, selected, dimmed }: { color: string; selected: boolean; dimmed: boolean }) {
  const opacity = dimmed ? 0.3 : 1;
  return (
    <group>
      <mesh position={[0, 0.06, 0]}>
        <cylinderGeometry args={[3.1, 3.35, 0.12, 64]} />
        <meshPhysicalMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 0.3 : 0.08}
          roughness={0.3}
          metalness={0.3}
          transparent
          opacity={0.28 * opacity}
          vertexColors={false}
        />
      </mesh>
      <mesh position={[0, 0.16, 0]}>
        <cylinderGeometry args={[2.62, 2.82, 0.1, 64]} />
        <meshPhysicalMaterial
          color="#141d2d"
          emissive={color}
          emissiveIntensity={selected ? 0.22 : 0.05}
          roughness={0.32}
          metalness={0.4}
          transparent
          opacity={0.9 * opacity}
        />
      </mesh>
      <mesh position={[0, 0.78, 0]}>
        <icosahedronGeometry args={[0.52, 1]} />
        <meshPhysicalMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 0.7 : 0.26}
          roughness={0.22}
          metalness={0.25}
          clearcoat={0.7}
          clearcoatRoughness={0.2}
          transparent
          opacity={opacity}
        />
      </mesh>
      <mesh position={[0, 0.78, 0]} rotation={[Math.PI / 2.7, 0.2, 0]}>
        <torusGeometry args={[0.88, 0.022, 10, 64]} />
        <meshBasicMaterial color={color} transparent opacity={0.55 * opacity} />
      </mesh>
      <mesh position={[0, 0.78, 0]} rotation={[Math.PI / 1.9, -0.5, 0.4]}>
        <torusGeometry args={[1.02, 0.014, 8, 64]} />
        <meshBasicMaterial color={color} transparent opacity={0.28 * opacity} />
      </mesh>
      <mesh position={[0, 0.25, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.86, 3.12, 64]} />
        <meshBasicMaterial color={color} transparent opacity={0.12 * opacity} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function FolderBlock({
  item,
  color,
  selected,
  connected,
  dimmed,
}: {
  item: Positioned3D;
  color: string;
  selected: boolean;
  connected: boolean;
  dimmed: boolean;
}) {
  const block = item.block ?? [1.2, 0.45, 1.2];
  const opacity = dimmed ? 0.28 : 0.96;
  return (
    <RoundedBox args={block} radius={Math.min(0.14, block[1] * 0.18)} smoothness={4}>
      <meshPhysicalMaterial
        color={color}
        emissive={color}
        emissiveIntensity={selected ? 0.3 : connected ? 0.1 : 0.055}
        roughness={0.34}
        metalness={0.18}
        clearcoat={0.45}
        clearcoatRoughness={0.26}
        transparent
        opacity={opacity}
      />
      {selected || connected ? <Edges color={color} /> : null}
    </RoundedBox>
  );
}

function FileCard({
  item,
  color,
  selected,
  connected,
  dimmed,
}: {
  item: Positioned3D;
  color: string;
  selected: boolean;
  connected: boolean;
  dimmed: boolean;
}) {
  const block = item.block ?? [0.92, 0.055, 0.66];
  const language = item.node.language ?? "other";
  const accent = LANGUAGE_COLOR[language] ?? color;
  return (
    <group>
      <RoundedBox args={block} radius={0.035} smoothness={3}>
        <meshPhysicalMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 0.5 : connected ? 0.15 : 0.06}
          roughness={0.18}
          metalness={0.1}
          clearcoat={0.9}
          clearcoatRoughness={0.12}
          transparent
          opacity={dimmed ? 0.24 : 0.74}
        />
        {selected || connected ? <Edges color={color} /> : null}
      </RoundedBox>
      <mesh position={[0, block[1] / 2 + 0.01, block[2] * 0.34]}>
        <boxGeometry args={[block[0] * 0.7, 0.012, 0.035]} />
        <meshBasicMaterial color={accent} transparent opacity={dimmed ? 0.3 : 0.95} />
      </mesh>
    </group>
  );
}

function DatabaseCore({
  size,
  color,
  selected,
  dimmed,
}: {
  size: number;
  color: string;
  selected: boolean;
  dimmed: boolean;
}) {
  return (
    <group>
      <mesh>
        <cylinderGeometry args={[size * 0.72, size * 0.72, size * 1.15, 24]} />
        <meshPhysicalMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 0.4 : 0.08}
          roughness={0.3}
          metalness={0.3}
          transparent
          opacity={dimmed ? 0.3 : 0.95}
        />
      </mesh>
      {[-0.24, 0, 0.24].map((offset) => (
        <mesh key={offset} position={[0, offset * size, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[size * 0.73, 0.012, 8, 32]} />
          <meshBasicMaterial color={color} transparent opacity={dimmed ? 0.15 : 0.6} />
        </mesh>
      ))}
    </group>
  );
}

function NodeGeometry({
  item,
  color,
  selected,
  connected,
  dimmed,
}: {
  item: Positioned3D;
  color: string;
  selected: boolean;
  connected: boolean;
  dimmed: boolean;
}) {
  const { node, size } = item;
  const opacity = dimmed ? 0.28 : 1;

  if (node.kind === "project") return <ProjectCore color={color} selected={selected} dimmed={dimmed} />;
  if (node.kind === "folder" || node.kind === "module") {
    return <FolderBlock item={item} color={color} selected={selected} connected={connected} dimmed={dimmed} />;
  }
  if (node.kind === "file") {
    return <FileCard item={item} color={color} selected={selected} connected={connected} dimmed={dimmed} />;
  }
  if (node.kind === "database") {
    return <DatabaseCore size={size} color={color} selected={selected} dimmed={dimmed} />;
  }
  if (node.kind === "route") {
    return (
      <mesh>
        <torusGeometry args={[size * 0.9, size * 0.25, 14, 36]} />
        <meshPhysicalMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 0.6 : 0.08}
          roughness={0.32}
          metalness={0.2}
          transparent
          opacity={opacity}
        />
      </mesh>
    );
  }
  if (node.kind === "event") {
    return (
      <mesh>
        <octahedronGeometry args={[size, 0]} />
        <meshPhysicalMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 0.6 : 0.08}
          roughness={0.3}
          metalness={0.2}
          transparent
          opacity={opacity}
        />
      </mesh>
    );
  }
  if (node.kind === "class" || node.kind === "interface" || node.kind === "type" || node.kind === "enum") {
    return (
      <mesh>
        <dodecahedronGeometry args={[size, 0]} />
        <meshPhysicalMaterial
          color={color}
          emissive={color}
          emissiveIntensity={selected ? 0.5 : 0.08}
          roughness={0.34}
          metalness={0.16}
          transparent
          opacity={opacity}
        />
      </mesh>
    );
  }
  return (
    <mesh>
      <sphereGeometry args={[size, 20, 20]} />
      <meshPhysicalMaterial
        color={color}
        emissive={color}
        emissiveIntensity={selected ? 0.75 : 0.22}
        roughness={0.28}
        metalness={0.18}
        clearcoat={0.6}
        clearcoatRoughness={0.2}
        transparent
        opacity={opacity}
      />
    </mesh>
  );
}

function NodeMesh({
  item,
  selected,
  connected,
  dimmed,
  showLabel,
  onSelect,
}: {
  item: Positioned3D;
  selected: boolean;
  connected: boolean;
  dimmed: boolean;
  showLabel: boolean;
  onSelect: (id: string) => void;
}) {
  const { node } = item;
  const [hovered, setHovered] = useState(false);
  const color = node.metadata?.unresolved ? "#fb7185" : KIND_COLOR[node.kind];
  const scale = selected ? 1.12 : hovered ? 1.06 : connected ? 1.03 : dimmed ? 0.92 : 1;
  const labelVisible =
    showLabel || selected || hovered || connected || node.kind === "project";
  const labelY =
    node.kind === "project"
      ? 1.42
      : item.block
        ? item.block[1] / 2 + 0.34
        : item.size + 0.32;

  return (
    <group position={item.position}>
      <group
        scale={scale}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "";
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(node.id);
        }}
      >
        <NodeGeometry item={item} color={color} selected={selected} connected={connected} dimmed={dimmed} />
      </group>
      {labelVisible ? (
        <LabelSprite
          node={node}
          color={color}
          selected={selected}
          connected={connected}
          y={labelY}
          onSelect={onSelect}
        />
      ) : null}
    </group>
  );
}

function PlatformLabel({ cluster }: { cluster: Cluster3D }) {
  const texture = useMemo(
    () => makeLabelTexture(cluster.label, cluster.color, false, false),
    [cluster.label, cluster.color],
  );
  useEffect(() => () => texture.dispose(), [texture]);
  const width = 2.1;
  return (
    <sprite position={[0, 0.55, cluster.depth * 0.56]} scale={[width, width * 0.32, 1]} renderOrder={90}>
      <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} opacity={0.9} />
    </sprite>
  );
}

function ClusterPlatforms({
  clusters,
  selectedClusterId,
}: {
  clusters: Cluster3D[];
  selectedClusterId: string | null;
}) {
  return (
    <>
      {clusters.map((cluster) => {
        const selected = cluster.id === selectedClusterId;
        return (
          <group key={cluster.id} position={[cluster.center[0], 0, cluster.center[2]]}>
            <RoundedBox args={[cluster.width * 1.1, 0.07, cluster.depth * 1.1]} radius={0.18} smoothness={3}>
              <meshBasicMaterial color={cluster.color} transparent opacity={selected ? 0.12 : 0.045} depthWrite={false} />
              <Edges color={selected ? cluster.color : "#294057"} />
            </RoundedBox>
            {cluster.rootId ? null : <PlatformLabel cluster={cluster} />}
          </group>
        );
      })}
    </>
  );
}

function FunctionStems({
  nodes,
  positionsById,
  selectedNodeId,
}: {
  nodes: Positioned3D[];
  positionsById: Map<string, Positioned3D>;
  selectedNodeId: string | null;
}) {
  return (
    <>
      {nodes.slice(0, 260).map((item) => {
        if (!item.parentFileId || (item.node.kind !== "function" && item.node.kind !== "method")) return null;
        const parent = positionsById.get(item.parentFileId);
        if (!parent) return null;
        const active = item.node.id === selectedNodeId || parent.node.id === selectedNodeId;
        return (
          <Line
            key={`stem:${item.node.id}`}
            points={[parent.position, item.position]}
            color="#39d5a0"
            lineWidth={active ? 1.1 : 0.35}
            transparent
            opacity={active ? 0.6 : 0.12}
            depthWrite={false}
          />
        );
      })}
    </>
  );
}

function FlowEdge({
  from,
  to,
  certainty,
  outgoing,
  opacity,
}: {
  from: [number, number, number];
  to: [number, number, number];
  certainty: Certainty;
  outgoing: boolean;
  opacity: number;
}) {
  const color = certainty === "unresolved" ? CERTAINTY_COLOR.unresolved : outgoing ? "#2dd4bf" : "#ff934b";
  const dotRef = useRef<THREE.Mesh>(null);
  const fromVector = useMemo(() => new THREE.Vector3(...from), [from]);
  const toVector = useMemo(() => new THREE.Vector3(...to), [to]);
  const target = useMemo(() => new THREE.Vector3(), []);
  const points = useMemo(() => [fromVector, toVector], [fromVector, toVector]);
  const offset = useMemo(() => (from[0] + from[2] + to[0] + to[2]) % 7, [from, to]);

  useFrame(({ clock }) => {
    if (!dotRef.current) return;
    const t = (clock.elapsedTime * 0.32 + offset * 0.07) % 1;
    target.lerpVectors(fromVector, toVector, outgoing ? t : 1 - t);
    dotRef.current.position.copy(target);
  });

  return (
    <>
      <Line
        points={points}
        color={color}
        lineWidth={certainty === "confirmed" ? 2.4 : 2}
        transparent
        opacity={opacity}
        dashed={certainty !== "confirmed"}
        dashSize={0.16}
        gapSize={0.1}
      />
      <mesh ref={dotRef}>
        <sphereGeometry args={[0.075, 10, 10]} />
        <meshBasicMaterial color={color} transparent opacity={opacity} />
      </mesh>
    </>
  );
}

function EdgeLines({
  edges,
  positionsById,
  selectedNodeId,
}: {
  edges: VisibleEdge[];
  positionsById: Map<string, Positioned3D>;
  selectedNodeId: string | null;
}) {
  return (
    <>
      {edges.slice(0, 420).map((edge) => {
        const source = positionsById.get(edge.source);
        const target = positionsById.get(edge.target);
        if (!source || !target) return null;
        const connected =
          Boolean(selectedNodeId) && (edge.source === selectedNodeId || edge.target === selectedNodeId);
        if (selectedNodeId && connected) {
          return (
            <FlowEdge
              key={edge.id}
              from={source.position}
              to={target.position}
              certainty={edge.certainty}
              outgoing={edge.source === selectedNodeId}
              opacity={0.95}
            />
          );
        }
        return (
          <Line
            key={edge.id}
            points={[source.position, target.position]}
            color={CERTAINTY_COLOR[edge.certainty]}
            lineWidth={edge.certainty === "confirmed" ? 1 : 0.8}
            transparent
            opacity={selectedNodeId ? 0.06 : 0.2}
            dashed={edge.certainty !== "confirmed"}
            dashSize={0.16}
            gapSize={0.12}
            depthWrite={false}
          />
        );
      })}
    </>
  );
}

function buildVisibleGraph(
  layoutNodes: Positioned3D[],
  allEdges: GraphEdge[],
  maxDepth: number,
  edgeMode: EdgeMode,
  selectedNodeId: string | null,
): { nodes: Positioned3D[]; edges: VisibleEdge[] } {
  const visible = new Set(
    layoutNodes.filter((item) => item.level <= maxDepth || item.node.id === selectedNodeId).map((item) => item.node.id),
  );
  const parentById = new Map<string, string>();
  for (const item of layoutNodes) {
    if (item.node.parentId) parentById.set(item.node.id, item.node.parentId);
  }

  function resolve(id: string): string | null {
    let current = id;
    for (let guard = 0; guard < 64; guard += 1) {
      if (visible.has(current)) return current;
      const parent = parentById.get(current);
      if (!parent) return null;
      current = parent;
    }
    return null;
  }

  const aggregated = new Map<string, VisibleEdge>();
  for (const edge of allEdges) {
    if (!edgeAllowed(edgeMode, edge.kind)) continue;
    if (edge.kind === "CONTAINS") {
      if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
      aggregated.set(edge.id, { ...edge, count: 1 });
      continue;
    }
    const source = resolve(edge.source);
    const target = resolve(edge.target);
    if (!source || !target || source === target) continue;
    const key = `${edge.kind}|${source}|${target}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.count += 1;
      existing.certainty = worstCertainty([existing.certainty, edge.certainty]);
      continue;
    }
    aggregated.set(key, {
      ...edge,
      id: `visible:${key}`,
      source,
      target,
      count: 1,
    });
  }

  return {
    nodes: layoutNodes.filter((item) => visible.has(item.node.id)),
    edges: [...aggregated.values()].slice(0, 500),
  };
}

export default function Universe3D({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  onOpenFile,
  onOpenFolder,
  truncated,
}: Universe3DProps) {
  const { t } = useI18n();
  const [layoutKind, setLayoutKind] = useState<Layout3DKind>("hybrid");
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("architecture");
  const [maxDepth, setMaxDepth] = useState(1);
  const [allLabels, setAllLabels] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(true);

  const layout = useMemo(() => layout3D(nodes, edges, layoutKind), [nodes, edges, layoutKind]);
  const positionsById = useMemo(
    () => new Map(layout.nodes.map((item) => [item.node.id, item])),
    [layout.nodes],
  );
  const selectedItem = selectedNodeId ? positionsById.get(selectedNodeId) : undefined;
  const effectiveDepth =
    layoutKind === "force"
      ? layout.maxLevel
      : Math.min(layout.maxLevel, Math.max(maxDepth, selectedItem ? selectedItem.level + 1 : 0));

  useEffect(() => {
    setMaxDepth(layoutKind === "force" || nodes.length <= 42 ? layout.maxLevel : 1);
  }, [layoutKind, layout.maxLevel, nodes.length]);

  useEffect(() => {
    const timer = window.setTimeout(() => setLayoutMenuOpen(false), 6000);
    return () => window.clearTimeout(timer);
  }, []);

  const groundY = useMemo(
    () => Math.min(...layout.nodes.map((item) => item.position[1]), 0) - 0.36,
    [layout.nodes],
  );
  const visible = useMemo(
    () => buildVisibleGraph(layout.nodes, edges, effectiveDepth, edgeMode, selectedNodeId),
    [layout.nodes, edges, effectiveDepth, edgeMode, selectedNodeId],
  );
  const visibleEdges = visible.edges;
  const visibleNodes = visible.nodes;

  const neighborIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    const neighbours = new Set<string>();
    for (const edge of visibleEdges) {
      if (edge.source === selectedNodeId) neighbours.add(edge.target);
      if (edge.target === selectedNodeId) neighbours.add(edge.source);
    }
    return neighbours;
  }, [visibleEdges, selectedNodeId]);

  const selectedClusterId = useMemo(() => {
    if (!selectedNodeId) return null;
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    let current = nodeById.get(selectedNodeId);
    for (let guard = 0; guard < 64 && current; guard += 1) {
      const parent = current.parentId ? nodeById.get(current.parentId) : undefined;
      if (!parent || parent.kind === "project") break;
      current = parent;
    }
    if (!current) return null;
    if (current.kind === "folder" || current.kind === "module") return current.id;
    return null;
  }, [nodes, selectedNodeId]);

  const showAllLabels = allLabels;
  const groundSize = Math.max(40, layout.radius * 2.7);
  const cellSize = Math.max(1, Math.round((layout.radius / 18) * 10) / 10);
  const sectionSize = Math.max(4, Math.round(cellSize * 5));

  function openIn2D(node: GraphNode) {
    if (node.kind === "file" && node.filePath) onOpenFile(node.filePath);
    else if (node.kind === "folder" && node.filePath) onOpenFolder(node.filePath);
  }

  return (
    <div className="universe-3d">
      <Canvas
        camera={{ position: [layout.radius * 1.35, layout.radius * 0.8, layout.radius * 1.7], fov: 44, near: 0.1, far: layout.radius * 18 }}
        dpr={[1, 1.8]}
        gl={{ antialias: true, powerPreference: "high-performance", toneMappingExposure: 0.9 }}
        onPointerMissed={() => onSelectNode(null)}
      >
        <color attach="background" args={["#04070c"]} />
        <fog attach="fog" args={["#04070c", layout.radius * 2.2, layout.radius * 7.5]} />
        <ambientLight intensity={0.2} />
        <hemisphereLight args={["#8fb6e8", "#101820", 0.16]} />
        <directionalLight position={[6, 10, 5]} intensity={0.58} />
        <pointLight position={[-layout.radius * 0.7, layout.radius * 0.5, -layout.radius * 0.6]} intensity={0.3} color="#6d8cff" decay={2} />
        <pointLight position={[layout.radius * 0.7, layout.radius * 0.2, layout.radius * 0.7]} intensity={0.22} color="#a855f7" decay={2} />

        <CameraRig center={layout.center} radius={layout.radius} />
        <LodController
          center={layout.center}
          radius={layout.radius}
          enabled={layoutKind !== "force" && nodes.length > 42}
          onDepth={(depth) => setMaxDepth((current) => (current === depth ? current : depth))}
        />
        <OrbitControls
          makeDefault
          target={layout.center}
          enablePan
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.68}
          zoomSpeed={0.8}
          minDistance={1.8}
          maxDistance={layout.radius * 7}
        />
        <NavigationBridge center={layout.center} radius={layout.radius} />

        <Grid
          args={[groundSize, groundSize]}
          position={[layout.center[0], groundY, layout.center[2]]}
          cellSize={cellSize}
          cellThickness={0.55}
          cellColor="#152334"
          sectionSize={sectionSize}
          sectionThickness={1}
          sectionColor="#213a55"
          fadeDistance={layout.radius * 2.8}
          fadeStrength={1.2}
          infiniteGrid={false}
          followCamera={false}
        />

        <ClusterPlatforms clusters={layout.clusters} selectedClusterId={selectedClusterId} />
        <FunctionStems nodes={visibleNodes} positionsById={positionsById} selectedNodeId={selectedNodeId} />
        <EdgeLines edges={visibleEdges} positionsById={positionsById} selectedNodeId={selectedNodeId} />

        {visibleNodes.map((item) => (
          <NodeMesh
            key={item.node.id}
            item={item}
            selected={item.node.id === selectedNodeId}
            connected={neighborIds.has(item.node.id)}
            dimmed={Boolean(selectedNodeId) && item.node.id !== selectedNodeId && !neighborIds.has(item.node.id)}
            showLabel={showAllLabels}
            onSelect={onSelectNode}
          />
        ))}

        <EffectComposer multisampling={0}>
          <Bloom intensity={0.16} luminanceThreshold={0.92} luminanceSmoothing={0.35} mipmapBlur />
          <Vignette eskil={false} offset={0.2} darkness={0.8} />
        </EffectComposer>
      </Canvas>

      <div className="universe-3d-controls">
        <div className="u3d-layout-control">
          <button
            className={`u3d-layout-trigger ${layoutMenuOpen ? "is-open" : ""}`}
            onClick={() => setLayoutMenuOpen((value) => !value)}
            title={t("Layout")}
          >
            <LayoutGrid size={12} />
            <span>
              {t("Layout")}: {t(LAYOUT_OPTIONS.find((option) => option.id === layoutKind)?.label ?? "Hybrid")}
            </span>
            <ChevronDown size={12} />
          </button>
          <div className={`u3d-layout-popover ${layoutMenuOpen ? "is-open" : ""}`}>
            {LAYOUT_OPTIONS.map((option) => (
              <button
                key={option.id}
                className={`u3d-layout-option ${layoutKind === option.id ? "is-active" : ""}`}
                onClick={() => {
                  setLayoutKind(option.id);
                  setLayoutMenuOpen(false);
                }}
                title={t(option.label)}
              >
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>
        <div className="u3d-control-group">
          <span className="u3d-control-label">{t("View")}</span>
          <div className="u3d-segmented">
            {EDGE_OPTIONS.map((option) => (
              <button
                key={option.id}
                className={edgeMode === option.id ? "is-active" : ""}
                onClick={() => setEdgeMode(option.id)}
                title={t(option.label)}
              >
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>
        <div className="u3d-control-group">
          <span className="u3d-control-label">{t("Labels")}</span>
          <button
            className={`u3d-label-toggle ${allLabels ? "is-active" : ""}`}
            onClick={() => setAllLabels((value) => !value)}
            title={t("Show all labels")}
          >
            <Tags size={12} />
            <span>{allLabels ? t("All labels") : t("Selected flow only")}</span>
          </button>
        </div>
        <div className="u3d-layer-hint">
          {layoutKind === "force"
            ? t("{count} nodes in the force graph", { count: layout.nodes.length })
            : t("Layer {depth}/{max} · zoom in to reveal deeper levels", {
                depth: effectiveDepth,
                max: layout.maxLevel,
              })}
        </div>
        {selectedItem &&
        (selectedItem.node.kind === "file" || selectedItem.node.kind === "folder") &&
        selectedItem.node.filePath ? (
          <button className="u3d-open2d" onClick={() => openIn2D(selectedItem.node)}>
            {t("Open selected item in 2D")}
          </button>
        ) : null}
      </div>

      <div className="universe-3d-nav" aria-label={t("3D navigation")}>
        <div className="u3d-nav-grid">
          <span />
          <button
            onClick={() => sendNavCommand({ type: "pan", horizontal: 0, vertical: 1 })}
            title={t("Pan up")}
            aria-label={t("Pan up")}
          >
            <ChevronUp size={14} />
          </button>
          <span />
          <button
            onClick={() => sendNavCommand({ type: "pan", horizontal: -1, vertical: 0 })}
            title={t("Pan left")}
            aria-label={t("Pan left")}
          >
            <ChevronLeft size={14} />
          </button>
          <button
            className="u3d-nav-reset"
            onClick={() => sendNavCommand({ type: "reset" })}
            title={t("Reset camera")}
            aria-label={t("Reset camera")}
          >
            <LocateFixed size={13} />
          </button>
          <button
            onClick={() => sendNavCommand({ type: "pan", horizontal: 1, vertical: 0 })}
            title={t("Pan right")}
            aria-label={t("Pan right")}
          >
            <ChevronRight size={14} />
          </button>
          <span />
          <button
            onClick={() => sendNavCommand({ type: "pan", horizontal: 0, vertical: -1 })}
            title={t("Pan down")}
            aria-label={t("Pan down")}
          >
            <ChevronDown size={14} />
          </button>
          <span />
        </div>
        <div className="u3d-nav-zoom">
          <button
            onClick={() => sendNavCommand({ type: "zoom", factor: 1.15 })}
            title={t("Zoom out")}
            aria-label={t("Zoom out")}
          >
            <Minus size={13} />
          </button>
          <button
            onClick={() => sendNavCommand({ type: "zoom", factor: 0.87 })}
            title={t("Zoom in")}
            aria-label={t("Zoom in")}
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      <div className="universe-3d-hud">
        <span>{t("Drag to orbit · scroll to zoom · hover for labels · click to inspect")}</span>
        {selectedNodeId ? (
          <span className="universe-3d-selected">
            {positionsById.get(selectedNodeId)?.node.label} ·{" "}
            {t("{count} connections highlighted", { count: neighborIds.size })}
          </span>
        ) : null}
        {truncated ? (
          <span className="universe-3d-note">{t("Large project: the 3D graph is capped for performance.")}</span>
        ) : null}
      </div>
      <div className="universe-3d-legend">
        {(["project", "folder", "file", "function", "route", "database", "event"] as const).map((kind) => (
          <span key={kind}>
            <i style={{ background: KIND_COLOR[kind] }} />
            {t(KIND_LABEL[kind])}
          </span>
        ))}
      </div>
    </div>
  );
}
