import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line, OrbitControls, RoundedBox, Stars } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import type { GraphEdge, GraphNode } from "../../../shared/types";
import { CERTAINTY_COLOR, KIND_COLOR, KIND_LABEL, truncate } from "../lib/constants";
import { useI18n } from "../i18n";

interface Universe3DProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onOpenFile: (filePath: string) => void;
  onOpenFolder: (folderPath: string) => void;
}

interface Positioned {
  node: GraphNode;
  position: [number, number, number];
  size: number;
}

function priority(node: GraphNode): number {
  switch (node.kind) {
    case "project":
      return 0;
    case "folder":
    case "module":
      return 1;
    case "file":
      return 2;
    case "class":
    case "interface":
    case "route":
    case "database":
    case "event":
      return 3;
    default:
      return 4;
  }
}

function positionsFor(nodes: GraphNode[]): Positioned[] {
  const capped = [...nodes].sort((a, b) => priority(a) - priority(b)).slice(0, 120);
  const project = capped.find((node) => node.kind === "project");
  const rest = capped.filter((node) => node !== project);
  const baseRadius = Math.max(5.5, Math.cbrt(Math.max(1, rest.length)) * 3.7);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const positioned: Positioned[] = [];

  if (project) positioned.push({ node: project, position: [0, 0, 0], size: 0.66 });

  rest.forEach((node, index) => {
    const folderLike = node.kind === "folder" || node.kind === "module";
    const radius = folderLike ? baseRadius * 0.64 : baseRadius;
    const t = rest.length <= 1 ? 0.5 : index / (rest.length - 1);
    const y = 1 - t * 2;
    const ring = Math.sqrt(Math.max(0.001, 1 - y * y));
    const angle = index * golden;
    positioned.push({
      node,
      position: [
        Math.cos(angle) * ring * radius,
        y * radius * 0.72,
        Math.sin(angle) * ring * radius,
      ],
      size:
        node.kind === "folder" || node.kind === "module"
          ? 0.48
          : node.kind === "file"
            ? 0.4
            : node.kind === "project"
              ? 0.66
              : 0.28,
    });
  });

  return positioned;
}

function CameraRig({ radius }: { radius: number }) {
  const { camera } = useThree();
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    camera.position.set(radius * 1.35, radius * 0.75, radius * 1.7);
    camera.lookAt(0, 0, 0);
    done.current = true;
  });
  return null;
}

function NodeSurface({
  node,
  size,
  children,
}: {
  node: GraphNode;
  size: number;
  children: React.ReactNode;
}) {
  if (node.kind === "folder" || node.kind === "module") {
    return (
      <RoundedBox args={[size, size, size]} radius={size * 0.16} smoothness={5}>
        {children}
      </RoundedBox>
    );
  }
  if (node.kind === "file") {
    return (
      <RoundedBox args={[size * 1.25, size * 0.7, size * 0.22]} radius={0.045} smoothness={4}>
        {children}
      </RoundedBox>
    );
  }
  if (node.kind === "project") {
    return (
      <mesh>
        <icosahedronGeometry args={[size, 1]} />
        {children}
      </mesh>
    );
  }
  if (node.kind === "database") {
    return (
      <mesh>
        <cylinderGeometry args={[size * 0.72, size * 0.72, size * 1.15, 24]} />
        {children}
      </mesh>
    );
  }
  if (node.kind === "route") {
    return (
      <mesh>
        <torusGeometry args={[size * 0.8, size * 0.23, 14, 32]} />
        {children}
      </mesh>
    );
  }
  if (node.kind === "event") {
    return (
      <mesh>
        <octahedronGeometry args={[size, 0]} />
        {children}
      </mesh>
    );
  }
  return (
    <mesh>
      <sphereGeometry args={[size, 28, 28]} />
      {children}
    </mesh>
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

  const radius = 14;
  context.beginPath();
  context.roundRect(0.5, 0.5, width - 1, height - 1, radius);
  context.fillStyle = selected ? "rgba(8, 15, 25, 0.97)" : connected ? "rgba(8, 14, 23, 0.9)" : "rgba(7, 12, 19, 0.82)";
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
  onOpen,
}: {
  node: GraphNode;
  color: string;
  selected: boolean;
  connected: boolean;
  y: number;
  onSelect: (id: string) => void;
  onOpen: (node: GraphNode) => void;
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
      onDoubleClick={(event) => {
        event.stopPropagation();
        onOpen(node);
      }}
    >
      <spriteMaterial map={texture} transparent depthTest={false} depthWrite={false} />
    </sprite>
  );
}

function NodeMesh({
  item,
  selected,
  connected,
  showLabel,
  onSelect,
  onOpen,
}: {
  item: Positioned;
  selected: boolean;
  connected: boolean;
  showLabel: boolean;
  onSelect: (id: string) => void;
  onOpen: (node: GraphNode) => void;
}) {
  const { node, position, size } = item;
  const [hovered, setHovered] = useState(false);
  const color = node.metadata?.unresolved ? "#fb7185" : KIND_COLOR[node.kind];
  const scale = selected ? 1.12 : hovered ? 1.06 : connected ? 1.03 : 1;
  const essentialLabel = node.kind === "project" || node.kind === "folder";
  const labelVisible = showLabel || essentialLabel || selected || hovered || connected;

  return (
    <group position={position}>
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
        onDoubleClick={(event) => {
          event.stopPropagation();
          onOpen(node);
        }}
      >
        <NodeSurface node={node} size={size}>
          <meshPhysicalMaterial
            color={color}
            emissive={color}
            emissiveIntensity={selected ? 0.4 : connected ? 0.08 : hovered ? 0.18 : 0.05}
            roughness={0.38}
            metalness={0.08}
            clearcoat={0.35}
            clearcoatRoughness={0.32}
            reflectivity={0.35}
          />
        </NodeSurface>
        {selected || connected ? (
          <group scale={selected ? 1.05 : 1.025}>
            <NodeSurface node={node} size={size}>
              <meshBasicMaterial
                color={color}
                transparent
                opacity={selected ? 0.06 : 0.02}
                depthWrite={false}
                blending={THREE.AdditiveBlending}
              />
            </NodeSurface>
          </group>
        ) : null}
      </group>
      {selected ? <pointLight color={color} intensity={0.35} distance={1.5} decay={2} /> : null}
      {labelVisible ? (
        <LabelSprite
          node={node}
          color={color}
          selected={selected}
          connected={connected}
          y={size + 0.42}
          onSelect={onSelect}
          onOpen={onOpen}
        />
      ) : null}
    </group>
  );
}

function GlowEdge({
  points,
  color,
  glowColor,
  dashed,
  opacity,
  pulse,
}: {
  points: [number, number, number][];
  color: string;
  glowColor: string;
  dashed: boolean;
  opacity: number;
  pulse: boolean;
}) {
  const core = useRef<any>(null);
  const glow = useRef<any>(null);

  useFrame(({ clock }) => {
    if (!pulse) return;
    const value = 0.84 + 0.16 * Math.sin(clock.elapsedTime * 1.8);
    if (core.current?.material) core.current.material.opacity = opacity * value;
    if (glow.current?.material) glow.current.material.opacity = 0.14 * value;
  });

  return (
    <>
      <Line
        ref={glow}
        points={points}
        color={glowColor}
        lineWidth={4.2}
        transparent
        opacity={0.14}
        depthWrite={false}
      />
      <Line
        ref={core}
        points={points}
        color={color}
        lineWidth={1.8}
        transparent
        opacity={opacity}
        dashed={dashed}
        dashSize={0.16}
        gapSize={0.1}
      />
    </>
  );
}

function EdgeLines({
  nodesById,
  edges,
  selectedNodeId,
  selectedColor,
}: {
  nodesById: Map<string, Positioned>;
  edges: GraphEdge[];
  selectedNodeId: string | null;
  selectedColor: string;
}) {
  return (
    <>
      {edges.slice(0, 240).map((edge) => {
        const source = nodesById.get(edge.source);
        const target = nodesById.get(edge.target);
        if (!source || !target) return null;
        const connected =
          Boolean(selectedNodeId) && (edge.source === selectedNodeId || edge.target === selectedNodeId);
        const dimmed = Boolean(selectedNodeId) && !connected;
        if (connected) {
          return (
            <GlowEdge
              key={edge.id}
              points={[source.position, target.position]}
              color={CERTAINTY_COLOR[edge.certainty]}
              glowColor={selectedColor}
              dashed={edge.certainty !== "confirmed"}
              opacity={0.95}
              pulse
            />
          );
        }
        return (
          <Line
            key={edge.id}
            points={[source.position, target.position]}
            color={CERTAINTY_COLOR[edge.certainty]}
            lineWidth={0.7}
            transparent
            opacity={dimmed ? 0.05 : 0.22}
            dashed={edge.certainty !== "confirmed"}
            dashSize={0.16}
            gapSize={0.12}
          />
        );
      })}
    </>
  );
}

export default function Universe3D({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  onOpenFile,
  onOpenFolder,
}: Universe3DProps) {
  const { t } = useI18n();
  const positioned = useMemo(() => positionsFor(nodes), [nodes]);
  const nodesById = useMemo(() => new Map(positioned.map((item) => [item.node.id, item])), [positioned]);
  const neighborIds = useMemo(() => {
    if (!selectedNodeId) return new Set<string>();
    const neighbours = new Set<string>();
    for (const edge of edges) {
      if (edge.source === selectedNodeId) neighbours.add(edge.target);
      if (edge.target === selectedNodeId) neighbours.add(edge.source);
    }
    return neighbours;
  }, [edges, selectedNodeId]);
  const radius = useMemo(
    () => positioned.reduce((max, item) => Math.max(max, Math.hypot(...item.position)), 5),
    [positioned],
  );
  const selectedColor = selectedNodeId
    ? KIND_COLOR[nodesById.get(selectedNodeId)?.node.kind ?? "project"]
    : "#8ab8ff";
  const showAllLabels = positioned.length <= 14;

  function openNode(node: GraphNode) {
    if (node.kind === "file" && node.filePath) onOpenFile(node.filePath);
    else if (node.kind === "folder" && node.filePath) onOpenFolder(node.filePath);
    else onSelectNode(node.id);
  }

  return (
    <div className="universe-3d">
      <Canvas
        camera={{ position: [radius * 1.35, radius * 0.75, radius * 1.7], fov: 46, near: 0.1, far: radius * 14 }}
        dpr={[1, 1.8]}
        gl={{ antialias: true, powerPreference: "high-performance", toneMappingExposure: 0.9 }}
        onPointerMissed={() => onSelectNode(null)}
      >
        <color attach="background" args={["#04070c"]} />
        <fog attach="fog" args={["#04070c", radius * 2.1, radius * 6.2]} />
        <ambientLight intensity={0.42} />
        <hemisphereLight args={["#93c5fd", "#1e293b", 0.36]} />
        <directionalLight position={[6, 9, 5]} intensity={0.95} />
        <pointLight position={[-radius, -radius, -radius]} intensity={0.65} color="#4f8cff" decay={2} />
        <pointLight position={[radius, radius * 0.4, radius]} intensity={0.45} color="#a855f7" decay={2} />
        <Stars radius={radius * 3.8} depth={radius * 2.2} count={1400} factor={2.4} saturation={0} fade={false} speed={0.1} />
        <CameraRig radius={radius} />
        <OrbitControls
          enablePan
          enableDamping
          dampingFactor={0.07}
          rotateSpeed={0.7}
          zoomSpeed={0.8}
          minDistance={2}
          maxDistance={radius * 7}
        />
        <EdgeLines
          nodesById={nodesById}
          edges={edges}
          selectedNodeId={selectedNodeId}
          selectedColor={selectedColor}
        />
        {positioned.map((item) => (
          <NodeMesh
            key={item.node.id}
            item={item}
            selected={item.node.id === selectedNodeId}
            connected={neighborIds.has(item.node.id)}
            showLabel={showAllLabels}
            onSelect={onSelectNode}
            onOpen={openNode}
          />
        ))}
        <EffectComposer multisampling={0}>
          <Bloom intensity={0.2} luminanceThreshold={0.9} luminanceSmoothing={0.3} mipmapBlur />
          <Vignette eskil={false} offset={0.14} darkness={0.78} />
        </EffectComposer>
      </Canvas>

      <div className="universe-3d-hud">
        <span>{t("Drag to orbit · scroll to zoom · hover for labels · click to inspect")}</span>
        {selectedNodeId ? (
          <span className="universe-3d-selected">
            {nodesById.get(selectedNodeId)?.node.label} · {t("{count} connections highlighted", { count: neighborIds.size })}
          </span>
        ) : null}
        {nodes.length > 120 ? (
          <span className="universe-3d-note">{t("Showing the first 120 nodes for performance.")}</span>
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
