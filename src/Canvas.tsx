import { previewFormula } from "../shared/formula";
import { useEffect, useRef, useState } from "react";
import {
  Stage,
  Layer,
  Group,
  Rect,
  Ellipse,
  Line,
  Text,
  Image as KImage,
  Transformer,
} from "react-konva";
import Konva from "konva";
import { fitBarcode, printerDots } from "../shared/barcode";
import type { LabelElement, LabelTemplate, Project } from "../shared/model";
import { resolveFields } from "../shared/model";
import { elementBounds } from "./editor";
function useImage(url?: string) {
  const [img, setImg] = useState<HTMLImageElement>();
  useEffect(() => {
    setImg(undefined);
    if (!url) return;
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = url;
    return () => {
      i.onload = null;
    };
  }, [url]);
  return img;
}
function Artwork({
  element: e,
  data,
  scale,
  assetUrl,
  dotsPerMm,
}: {
  element: LabelElement;
  data: Record<string, string>;
  scale: number;
  assetUrl?: string;
  dotsPerMm: number;
}) {
  const [barcode, setBarcode] = useState("");
  const [barcodeOffsetX, setBarcodeOffsetX] = useState(0);
  useEffect(() => {
    if (e.type !== "barcode") return;
    let stale = false;
    setBarcode("");
    import("bwip-js/browser").then(async ({ default: bwipjs }) => {
      try {
        const fitted = await fitBarcode(
          e.symbology,
          e.dataMode === "formula" ? previewFormula(e.value, data) : e.dataMode === "literal" ? e.value : resolveFields(e.value, data),
          printerDots(e.widthUm, dotsPerMm),
          printerDots(e.heightUm, dotsPerMm),
          async (options) => {
            const canvas = document.createElement("canvas");
            bwipjs.toCanvas(canvas, options);
            return { image: canvas, width: canvas.width, height: canvas.height };
          },
        );
        const canvas = document.createElement("canvas");
        canvas.width = fitted.width;
        canvas.height = fitted.height;
        const context = canvas.getContext("2d")!;
        context.imageSmoothingEnabled = false;
        context.drawImage(fitted.image, 0, 0, fitted.width, fitted.height);
        if (!stale) {
          setBarcodeOffsetX(fitted.offsetX);
          setBarcode(canvas.toDataURL());
        }
      } catch {
        if (!stale) setBarcode("");
      }
    });
    return () => {
      stale = true;
    };
  }, [JSON.stringify(e), JSON.stringify(data), dotsPerMm]);
  const image = useImage(e.type === "barcode" ? barcode : assetUrl);
  const w = e.widthUm * scale,
    h = e.heightUm * scale;
  if (e.type === "text")
    return (
      <Text
        text={e.dataMode === "formula" ? previewFormula(e.text, data) : e.dataMode === "literal" ? e.text : resolveFields(e.text, data)}
        width={w}
        height={h}
        fontFamily={e.fontFamily}
        fontSize={e.fontSizeUm * scale}
        fontStyle={e.bold ? "bold" : "normal"}
        align={e.align}
        fill="#000"
        lineHeight={e.lineHeightUm ? e.lineHeightUm / e.fontSizeUm : 1.15}
      />
    );
  if (e.type === "rectangle")
    return (
      <Rect
        width={w}
        height={h}
        cornerRadius={Math.min(e.cornerRadiusUm ?? 0, e.widthUm / 2, e.heightUm / 2) * scale}
        stroke="black"
        strokeWidth={e.strokeUm * scale}
        fill={e.fill === "none" ? undefined : e.fill}
      />
    );
  if (e.type === "ellipse")
    return (
      <Ellipse
        x={w / 2}
        y={h / 2}
        radiusX={w / 2}
        radiusY={h / 2}
        stroke="black"
        strokeWidth={e.strokeUm * scale}
        fill={e.fill === "none" ? undefined : e.fill}
      />
    );
  if (e.type === "line")
    return (
      <Line
        points={[0, (e.strokeUm * scale) / 2, w, (e.strokeUm * scale) / 2]}
        stroke="black"
        strokeWidth={Math.max(1, e.strokeUm * scale)}
      />
    );
  return image ? (
    <KImage
      image={image}
      x={e.type === "barcode" ? barcodeOffsetX * 1000 * scale / dotsPerMm : 0}
      width={e.type === "barcode" ? image.width * 1000 * scale / dotsPerMm : w}
      height={e.type === "barcode" ? image.height * 1000 * scale / dotsPerMm : h}
      imageSmoothingEnabled={e.type !== "barcode"}
    />
  ) : (
    <>
      <Rect width={w} height={h} stroke="#a3aab3" fill="#f5f6f8" />
      <Text
        text={e.type === "barcode" ? "Invalid barcode" : "Image"}
        width={w}
        height={h}
        align="center"
        verticalAlign="middle"
        fill="#697482"
        fontSize={12}
      />
    </>
  );
}
export default function Canvas({
  template,
  project,
  selected,
  onSelect,
  onChange,
  zoom,
  grid,
  snap,
  unit,
  data,
  assetUrls,
  onDoubleClick,
  authoritativePreview,
  dotsPerMm,
  onGuideChange,
  auditId,
}: {
  template: LabelTemplate;
  project: Project;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onChange: (elements: LabelElement[]) => void;
  zoom: number;
  grid: boolean;
  snap: boolean;
  unit: "mm" | "in";
  data: Record<string, string>;
  assetUrls: Record<string, string>;
  onDoubleClick: () => void;
  authoritativePreview?: string;
  dotsPerMm: number;
  onGuideChange: (guides: NonNullable<LabelTemplate["guides"]>) => void;
  auditId?: string;
}) {
  const container = useRef<HTMLDivElement>(null),
    stage = useRef<Konva.Stage>(null),
    transformer = useRef<Konva.Transformer>(null);
  const [size, setSize] = useState({ w: 850, h: 600 });
  const [pan, setPan] = useState({ x: 70, y: 75 });
  const [space, setSpace] = useState(false);
  const [marquee, setMarquee] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  }>();
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const dragging = useRef(false);
  const guideAxis = useRef<"x" | "y" | undefined>(undefined);
  const [guidePreview, setGuidePreview] = useState<{
    axis: "x" | "y";
    positionUm: number;
  }>();
  const scale = zoom * 0.005;
  const w = template.widthUm * scale,
    h = template.heightUm * scale;
  const preview = useImage(
    authoritativePreview
      ? `data:image/png;base64,${authoritativePreview}`
      : undefined,
  );
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!container.current?.getClientRects().length) return;
      if (
        e.code === "Space" &&
        !/INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY/.test((e.target as HTMLElement).tagName) &&
        !document.querySelector('[role="dialog"]')
      ) {
        setSpace(true);
        e.preventDefault();
      }
    };
    const up = () => setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", up);
    };
  }, []);
  useEffect(() => {
    const nodes = selected
      .filter((id) => !template.elements.find((e) => e.id === id)?.locked)
      .map((id) => stage.current?.findOne((node: Konva.Node) => node.id() === id))
      .filter((n): n is Konva.Node => !!n);
    transformer.current?.nodes(nodes);
  }, [selected, template, zoom]);
  const choose = (e: LabelElement, event: any) => {
    event.cancelBubble = true;
    if (space) {
      const p = stage.current!.getPointerPosition()!;
      dragging.current = true;
      start.current = { x: p.x - pan.x, y: p.y - pan.y };
      return;
    }
    const peers = e.groupId
      ? template.elements
          .filter((x) => x.groupId === e.groupId)
          .map((x) => x.id)
      : [e.id];
    if (event.evt.shiftKey) {
      const all = selected.includes(e.id)
        ? selected.filter((x) => !peers.includes(x))
        : [...new Set([...selected, ...peers])];
      onSelect(all);
    } else if (!selected.includes(e.id)) onSelect(peers);
  };
  const update = (e: LabelElement, node: Konva.Node, transform = false) => {
    let x = Math.round(node.x() / scale),
      y = Math.round(node.y() / scale);
    if (snap) {
      x = Math.round(x / 1000) * 1000;
      y = Math.round(y / 1000) * 1000;
      const edgeX = template.elements
        .filter((x) => x.id !== e.id)
        .flatMap((x) => [x.xUm, x.xUm + x.widthUm]);
      const edgeY = template.elements
        .filter((x) => x.id !== e.id)
        .flatMap((x) => [x.yUm, x.yUm + x.heightUm]);
      edgeX.push(
        ...(template.guides ?? [])
          .filter((g) => g.axis === "x")
          .map((g) => g.positionUm),
      );
      edgeY.push(
        ...(template.guides ?? [])
          .filter((g) => g.axis === "y")
          .map((g) => g.positionUm),
      );
      for (const edge of edgeX) if (Math.abs(edge - x) * scale < 5) x = edge;
      for (const edge of edgeY) if (Math.abs(edge - y) * scale < 5) y = edge;
    }
    const dx = x - e.xUm,
      dy = y - e.yUm;
    onChange(
      template.elements.map((item) => {
        if (item.id === e.id)
          return {
            ...item,
            xUm: x,
            yUm: y,
            widthUm: transform
              ? Math.max(100, Math.round(item.widthUm * node.scaleX()))
              : item.widthUm,
            heightUm: transform
              ? Math.max(100, Math.round(item.heightUm * node.scaleY()))
              : item.heightUm,
            rotation: transform ? node.rotation() : item.rotation,
          };
        if (!transform && selected.includes(item.id) && !item.locked)
          return { ...item, xUm: item.xUm + dx, yUm: item.yUm + dy };
        return item;
      }),
    );
    node.scaleX(1);
    node.scaleY(1);
  };
  const rulerStep = unit === "mm" ? 10000 : 25400;
  const ticksX = Array.from(
    { length: Math.ceil(template.widthUm / rulerStep) + 1 },
    (_, i) => i * rulerStep,
  );
  const ticksY = Array.from(
    { length: Math.ceil(template.heightUm / rulerStep) + 1 },
    (_, i) => i * rulerStep,
  );
  return (
    <div
      className="canvas-container"
      data-editor-control={auditId}
      role="region"
      aria-label="Label canvas"
      tabIndex={0}
      onDoubleClick={() => {
        const pointer = stage.current?.getPointerPosition();
        const target = pointer ? stage.current?.getIntersection(pointer) : undefined;
        if (target?.getAncestors().some(node => template.elements.some(e => e.id === node.id())))
          requestAnimationFrame(onDoubleClick);
      }}
      data-authoritative={preview ? "true" : "false"}
      ref={container}
      style={{ cursor: space ? "grab" : "default" }}
    >
      <Stage
        ref={stage}
        width={size.w}
        height={size.h}
        onMouseDown={(event) => {
          if (event.target !== stage.current) return;
          const p = stage.current!.getPointerPosition()!;
          if (space) {
            dragging.current = true;
            start.current = { x: p.x - pan.x, y: p.y - pan.y };
          } else {
            onSelect([]);
            start.current = p;
            setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
          }
        }}
        onMouseMove={() => {
          const p = stage.current?.getPointerPosition();
          if (guideAxis.current && p) {
            setGuidePreview({
              axis: guideAxis.current,
              positionUm:
                Math.round(
                  (guideAxis.current === "x" ? p.x - pan.x : p.y - pan.y) /
                    scale /
                    100,
                ) * 100,
            });
            return;
          }
          if (!start.current || !p) return;
          if (dragging.current)
            setPan({ x: p.x - start.current.x, y: p.y - start.current.y });
          else
            setMarquee({
              x: start.current.x,
              y: start.current.y,
              w: p.x - start.current.x,
              h: p.y - start.current.y,
            });
        }}
        onMouseUp={() => {
          if (guideAxis.current) {
            if (
              guidePreview &&
              guidePreview.positionUm >= 0 &&
              guidePreview.positionUm <=
                (guidePreview.axis === "x"
                  ? template.widthUm
                  : template.heightUm)
            )
              onGuideChange([
                ...(template.guides ?? []),
                { id: crypto.randomUUID(), ...guidePreview },
              ]);
            guideAxis.current = undefined;
            setGuidePreview(undefined);
            return;
          }
          if (marquee) {
            const x = Math.min(marquee.x, marquee.x + marquee.w) - pan.x,
              y = Math.min(marquee.y, marquee.y + marquee.h) - pan.y;
            const right = x + Math.abs(marquee.w),
              bottom = y + Math.abs(marquee.h);
            onSelect(
              template.elements
                .filter((e) => {
                  const bounds = elementBounds(e);
                  return bounds.left * scale >= x && bounds.top * scale >= y && bounds.right * scale <= right && bounds.bottom * scale <= bottom;
                })
                .flatMap((e) => e.groupId ? template.elements.filter(peer => peer.groupId === e.groupId).map(peer => peer.id) : [e.id])
                .filter((id, i, ids) => ids.indexOf(id) === i),
            );
          }
          start.current = undefined;
          dragging.current = false;
          setMarquee(undefined);
        }}
      >
        <Layer>
          <Group x={pan.x} y={pan.y}>
            <Rect
              width={w}
              height={h}
              fill="white"
              shadowColor="#24374b"
              shadowBlur={18}
              shadowOpacity={0.2}
              shadowOffset={{ x: 2, y: 5 }}
              onMouseDown={(event) => {
                event.cancelBubble = true;
                onSelect([]);
                const p = stage.current!.getPointerPosition()!;
                if (space) {
                  dragging.current = true;
                  start.current = { x: p.x - pan.x, y: p.y - pan.y };
                } else {
                  start.current = p;
                  setMarquee({ x: p.x, y: p.y, w: 0, h: 0 });
                }
              }}
            />
            {grid &&
              Array.from(
                { length: Math.ceil(template.widthUm / 5000) },
                (_, i) =>
                  Array.from(
                    { length: Math.ceil(template.heightUm / 5000) },
                    (_, j) => (
                      <Rect
                        key={`${i},${j}`}
                        x={i * 5000 * scale}
                        y={j * 5000 * scale}
                        width={1}
                        height={1}
                        fill="#b9c9d9"
                        listening={false}
                      />
                    ),
                  ),
              )}
            <Rect
              width={w}
              height={h}
              stroke="#c1c5cb"
              strokeWidth={1}
              listening={false}
            />
            {preview && (
              <KImage image={preview} width={w} height={h} listening={false} />
            )}
            {preview &&
              grid &&
              Array.from(
                { length: Math.ceil(template.widthUm / 5000) },
                (_, i) =>
                  Array.from(
                    { length: Math.ceil(template.heightUm / 5000) },
                    (_, j) => (
                      <Rect
                        key={`dot${i},${j}`}
                        x={i * 5000 * scale}
                        y={j * 5000 * scale}
                        width={1}
                        height={1}
                        fill="#b9c9d9"
                        listening={false}
                      />
                    ),
                  ),
              )}
            {(template.guides ?? []).map((g) => (
              <Group
                key={g.id}
                x={g.axis === "x" ? g.positionUm * scale : 0}
                y={g.axis === "y" ? g.positionUm * scale : 0}
                draggable
                dragBoundFunc={(p) =>
                  g.axis === "x" ? { x: p.x, y: pan.y } : { x: pan.x, y: p.y }
                }
                onMouseDown={(e) => {
                  e.cancelBubble = true;
                }}
                onDblClick={() =>
                  onGuideChange(
                    (template.guides ?? []).filter((v) => v.id !== g.id),
                  )
                }
                onDragEnd={(e) => {
                  const pos = Math.round(
                    (g.axis === "x" ? e.target.x() : e.target.y()) / scale,
                  );
                  onGuideChange(
                    (template.guides ?? []).map((v) =>
                      v.id === g.id ? { ...v, positionUm: pos } : v,
                    ),
                  );
                }}
              >
                <Line
                  points={g.axis === "x" ? [0, 0, 0, h] : [0, 0, w, 0]}
                  stroke="#2499bf"
                  strokeWidth={1}
                  dash={[4, 4]}
                  hitStrokeWidth={8}
                />
              </Group>
            ))}
            {guidePreview && (
              <Line
                points={
                  guidePreview.axis === "x"
                    ? [
                        guidePreview.positionUm * scale,
                        0,
                        guidePreview.positionUm * scale,
                        h,
                      ]
                    : [
                        0,
                        guidePreview.positionUm * scale,
                        w,
                        guidePreview.positionUm * scale,
                      ]
                }
                stroke="#2499bf"
                strokeWidth={1}
                dash={[4, 4]}
                listening={false}
              />
            )}
            <Group clipX={0} clipY={0} clipWidth={w} clipHeight={h}>
              {template.elements.map((e) => (
                <Group
                  key={e.id}
                  id={e.id}
                  x={e.xUm * scale}
                  y={e.yUm * scale}
                  rotation={e.rotation}
                  draggable={!e.locked && !space}
                  onMouseDown={(ev) => choose(e, ev)}
                  onTap={(ev) => choose(e, ev)}
                  onDragEnd={(ev) => update(e, ev.target)}
                >
                  <Rect
                    width={e.widthUm * scale}
                    height={e.heightUm * scale}
                    fill="rgba(255,255,255,0.001)"
                  />
                  {!preview && (
                    <Artwork
                      element={e}
                      data={data}
                      scale={scale}
                      dotsPerMm={dotsPerMm}
                      assetUrl={
                        e.type === "image" ? assetUrls[e.assetId] : undefined
                      }
                    />
                  )}
                </Group>
              ))}
            </Group>
            <Transformer
              ref={transformer}
              onTransformEnd={() => {
                const nodes = new Map(
                  selected.map((id) => [id, stage.current?.findOne((node: Konva.Node) => node.id() === id)]),
                );
                onChange(
                  template.elements.map((e) => {
                    const node = nodes.get(e.id);
                    if (!node || e.locked) return e;
                    return {
                      ...e,
                      xUm: Math.round(node.x() / scale),
                      yUm: Math.round(node.y() / scale),
                      widthUm: Math.max(
                        100,
                        Math.round(e.widthUm * node.scaleX()),
                      ),
                      heightUm: Math.max(
                        100,
                        Math.round(
                          (e.type === "line" ? e.strokeUm : e.heightUm) *
                            node.scaleY(),
                        ),
                      ),
                      ...(e.type === "line"
                        ? {
                            strokeUm: Math.max(
                              1,
                              Math.round(e.strokeUm * node.scaleY()),
                            ),
                          }
                        : {}),
                      rotation: node.rotation(),
                    };
                  }),
                );
                for (const node of nodes.values()) {
                  node?.scaleX(1);
                  node?.scaleY(1);
                }
              }}
              rotateEnabled
              flipEnabled={false}
              borderStroke="#2763b0"
              anchorStroke="#2763b0"
              anchorFill="white"
              anchorSize={7}
              padding={2}
              boundBoxFunc={(oldBox, newBox) =>
                Math.abs(newBox.width) < 5 || Math.abs(newBox.height) < 2
                  ? oldBox
                  : newBox
              }
            />
          </Group>
          {marquee && (
            <Rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
              stroke="#3478cb"
              fill="rgba(52,120,203,.10)"
              listening={false}
            />
          )}
          <Rect
            x={0}
            y={0}
            width={size.w}
            height={24}
            fill="#edf0f3"
            onMouseDown={(e) => {
              e.cancelBubble = true;
              guideAxis.current = "y";
            }}
          />
          <Rect
            x={0}
            y={24}
            width={24}
            height={size.h - 24}
            fill="#edf0f3"
            onMouseDown={(e) => {
              e.cancelBubble = true;
              guideAxis.current = "x";
            }}
          />
          {ticksX.map((u, i) => (
            <Group key={"x" + i} x={pan.x + u * scale} listening={false}>
              <Line points={[0, 14, 0, 24]} stroke="#8a96a4" />
              <Text
                x={3}
                y={4}
                text={String(unit === "mm" ? u / 1000 : u / 25400)}
                fontSize={10}
                fill="#5a6572"
              />
            </Group>
          ))}
          {ticksY.map((u, i) => (
            <Group key={"y" + i} y={pan.y + u * scale} listening={false}>
              <Line points={[14, 0, 24, 0]} stroke="#8a96a4" />
              <Text
                x={3}
                y={2}
                text={String(unit === "mm" ? u / 1000 : u / 25400)}
                fontSize={10}
                rotation={-90}
                fill="#5a6572"
              />
            </Group>
          ))}
          <Rect width={24} height={24} fill="#dfe5eb" />
        </Layer>
      </Stage>
      <div className="canvas-hint">
        Drag a ruler to add a guide · Space + drag to pan · Shift to select
      </div>
    </div>
  );
}
