import Point from '@mapbox/point-geometry';
import {classifyRings} from '@maplibre/maplibre-gl-style-spec';
import {CircleBucket} from './circle_bucket.ts';
import {FillLayoutArray, HeatmapLineLayoutArray} from '../array_types.g.ts';
import {members as fillLayoutAttributes} from './fill_attributes.ts';
import {members as lineLayoutAttributes} from './heatmap_line_attributes.ts';
import {SegmentVector} from '../segment.ts';
import {ProgramConfigurationSet} from '../program_configuration.ts';
import {TriangleIndexArray} from '../index_array_type.ts';
import {EXTENT} from '../extent.ts';
import {subdividePolygon, subdivideVertexLine} from '../../render/subdivision.ts';
import {fillLargeMeshArrays} from '../../render/fill_large_mesh_arrays.ts';
import {register} from '../../util/web_worker_transfer.ts';

import type {HeatmapStyleLayer} from '../../style/style_layer/heatmap_style_layer.ts';
import type {BucketFeature, BucketParameters, IndexedFeature, PopulateParameters} from '../bucket.ts';
import type {CanonicalTileID} from '../../tile/tile_id.ts';
import type {CircleGranularity, SubdivisionGranularitySetting} from '../../render/subdivision_granularity_settings.ts';
import type {Context} from '../../webgl/context.ts';
import type {IndexBuffer} from '../../webgl/index_buffer.ts';
import type {VertexBuffer} from '../../webgl/vertex_buffer.ts';
import type {FeatureStates} from '../../source/source_state.ts';
import type {ImagePosition} from '../../render/image_atlas.ts';
import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

const EARCUT_MAX_RINGS = 500;

/**
 * The fewest cells per tile side that lines and polygons are subdivided into. Their shaders place
 * each vertex at the terrain's elevation, so a shape follows the ground only as closely as its
 * vertices are spaced; without terrain the extra vertices change nothing.
 */
const MIN_SHAPE_GRANULARITY = 16;

/** Vector tile geometry types, as `feature.type` holds them. */
const LINE_STRING = 2;
const POLYGON = 3;

/**
 * Returns the part of the segment from `a` to `b` that lies inside the tile, or `null` when none of it does.
 *
 * A line's kernel spreads past the tile edge, so the segment itself must stop at the edge: the
 * neighbouring tile draws the rest of the line, and the two pieces add up to exactly the whole.
 */
export function clipSegmentToTile(a: Point, b: Point): [Point, Point] | null {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    const edges: Array<[number, number]> = [
        [-dx, a.x],
        [dx, EXTENT - a.x],
        [-dy, a.y],
        [dy, EXTENT - a.y]
    ];
    for (const [p, q] of edges) {
        if (p === 0) {
            if (q < 0) return null;
            continue;
        }
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
        if (t0 > t1) return null;
    }
    return [
        new Point(a.x + t0 * dx, a.y + t0 * dy),
        new Point(a.x + t1 * dx, a.y + t1 * dy)
    ];
}

/**
 * Returns the part of a polygon ring inside the tile, clipping it against each tile edge in turn,
 * or an empty ring when none of it is inside.
 *
 * Each ring of a polygon can be clipped on its own because the tile is convex. Every vertex of the
 * result lies inside the tile, where the terrain under it is known, so a polygon can be drawn at
 * its elevation.
 */
export function clipRingToTile(ring: Point[]): Point[] {
    const edges: Array<{inside: (p: Point) => boolean; cross: (a: Point, b: Point) => Point}> = [
        {inside: p => p.x >= 0, cross: (a, b) => new Point(0, a.y + (b.y - a.y) * (0 - a.x) / (b.x - a.x))},
        {inside: p => p.x <= EXTENT, cross: (a, b) => new Point(EXTENT, a.y + (b.y - a.y) * (EXTENT - a.x) / (b.x - a.x))},
        {inside: p => p.y >= 0, cross: (a, b) => new Point(a.x + (b.x - a.x) * (0 - a.y) / (b.y - a.y), 0)},
        {inside: p => p.y <= EXTENT, cross: (a, b) => new Point(a.x + (b.x - a.x) * (EXTENT - a.y) / (b.y - a.y), EXTENT)}
    ];
    let points = ring;
    for (const {inside, cross} of edges) {
        const clipped: Point[] = [];
        for (let i = 0; i < points.length; i++) {
            const current = points[i];
            const previous = points[(i + points.length - 1) % points.length];
            if (inside(current)) {
                if (!inside(previous)) clipped.push(cross(previous, current));
                clipped.push(current);
            } else if (inside(previous)) {
                clipped.push(cross(previous, current));
            }
        }
        points = clipped;
        if (!points.length) break;
    }
    return points.map(p => new Point(Math.round(p.x), Math.round(p.y)));
}

/**
 * The bucket of a `heatmap` layer.
 *
 * With `heatmap-geometry: vertices`, every vertex of every feature is drawn as a point kernel, which
 * is what `CircleBucket` builds. With `shapes`, points are still drawn that way, but each segment of
 * a line becomes a quad whose shader integrates the kernel along the segment, and each polygon is
 * triangulated so its coverage can be drawn and then blurred by the kernel.
 */
export class HeatmapBucket extends CircleBucket<HeatmapStyleLayer> {
    // Needed for flow to accept omit: ['layers'] below, due to
    // https://github.com/facebook/flow/issues/4262
    layers: HeatmapStyleLayer[];

    lineLayoutVertexArray: HeatmapLineLayoutArray;
    lineLayoutVertexBuffer: VertexBuffer;
    lineIndexArray: TriangleIndexArray;
    lineIndexBuffer: IndexBuffer;
    lineSegments: SegmentVector;
    lineProgramConfigurations: ProgramConfigurationSet<HeatmapStyleLayer>;

    fillLayoutVertexArray: FillLayoutArray;
    fillLayoutVertexBuffer: VertexBuffer;
    fillIndexArray: TriangleIndexArray;
    fillIndexBuffer: IndexBuffer;
    fillSegments: SegmentVector;
    fillProgramConfigurations: ProgramConfigurationSet<HeatmapStyleLayer>;

    /** The subdivision settings of the `populate` call in progress; not kept once it returns. */
    subdivisionGranularity: SubdivisionGranularitySetting | undefined;

    constructor(options: BucketParameters<HeatmapStyleLayer>) {
        super(options);
        this.lineLayoutVertexArray = new HeatmapLineLayoutArray();
        this.lineIndexArray = new TriangleIndexArray();
        this.lineSegments = new SegmentVector();
        this.lineProgramConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);

        this.fillLayoutVertexArray = new FillLayoutArray();
        this.fillIndexArray = new TriangleIndexArray();
        this.fillSegments = new SegmentVector();
        this.fillProgramConfigurations = new ProgramConfigurationSet(options.layers, options.zoom);
    }

    populate(features: IndexedFeature[], options: PopulateParameters, canonical: CanonicalTileID): void {
        this.subdivisionGranularity = options.subdivisionGranularity;
        super.populate(features, options, canonical);
        this.subdivisionGranularity = undefined;
    }

    addFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID, granularity: CircleGranularity = 1): void {
        if (this.layers[0].drawsShapes() && feature.type === LINE_STRING) {
            this.addLineFeature(feature, geometry, index, canonical);
        } else if (this.layers[0].drawsShapes() && feature.type === POLYGON) {
            this.addPolygonFeature(feature, geometry, index, canonical);
        } else {
            super.addFeature(feature, geometry, index, canonical, granularity);
        }
    }

    /**
     * Adds one quad per segment of each line, clipped to the tile and subdivided so that it follows
     * the globe. Joins need no geometry of their own: the kernel integrated along a polyline is the sum
     * of its integrals along the segments.
     */
    addLineFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID): void {
        const granularity = Math.max(this.subdivisionGranularity?.line.getGranularityForZoomLevel(canonical.z) ?? 1, MIN_SHAPE_GRANULARITY);
        for (const line of geometry) {
            const points = subdivideVertexLine(line, granularity);
            for (let i = 0; i < points.length - 1; i++) {
                const clipped = clipSegmentToTile(points[i], points[i + 1]);
                if (clipped) this.addLineSegment(clipped[0], clipped[1]);
            }
        }
        this.lineProgramConfigurations.populatePaintArrays(this.lineLayoutVertexArray.length, feature, index, {imagePositions: {}, canonical});
    }

    addLineSegment(a: Point, b: Point): void {
        const x0 = Math.round(a.x), y0 = Math.round(a.y), x1 = Math.round(b.x), y1 = Math.round(b.y);
        if (x0 === x1 && y0 === y1) return;

        const segment = this.lineSegments.prepareSegment(4, this.lineLayoutVertexArray, this.lineIndexArray);
        const first = segment.vertexLength;
        this.lineLayoutVertexArray.emplaceBack(x0, y0, x1, y1, 0, -1);
        this.lineLayoutVertexArray.emplaceBack(x0, y0, x1, y1, 0, 1);
        this.lineLayoutVertexArray.emplaceBack(x0, y0, x1, y1, 1, -1);
        this.lineLayoutVertexArray.emplaceBack(x0, y0, x1, y1, 1, 1);
        this.lineIndexArray.emplaceBack(first, first + 1, first + 2);
        this.lineIndexArray.emplaceBack(first + 1, first + 3, first + 2);
        segment.vertexLength += 4;
        segment.primitiveLength += 2;
    }

    /** Triangulates the part of each polygon inside the tile, subdivided to follow the globe and the terrain. */
    addPolygonFeature(feature: BucketFeature, geometry: Point[][], index: number, canonical: CanonicalTileID): void {
        const granularity = Math.max(this.subdivisionGranularity?.fill.getGranularityForZoomLevel(canonical.z) ?? 1, MIN_SHAPE_GRANULARITY);
        const vertexArray = this.fillLayoutVertexArray;
        for (const polygon of classifyRings(geometry, EARCUT_MAX_RINGS)) {
            const outer = clipRingToTile(polygon[0]);
            if (outer.length < 3) continue;
            const holes = polygon.slice(1).map(clipRingToTile).filter(ring => ring.length >= 3);
            const subdivided = subdividePolygon([outer, ...holes], canonical, granularity, false);
            fillLargeMeshArrays(
                (x, y) => vertexArray.emplaceBack(x, y),
                this.fillSegments,
                vertexArray,
                this.fillIndexArray,
                subdivided.verticesFlattened,
                subdivided.indicesTriangles
            );
        }
        this.fillProgramConfigurations.populatePaintArrays(vertexArray.length, feature, index, {imagePositions: {}, canonical});
    }

    update(states: FeatureStates, vtLayer: VectorTileLayerLike, imagePositions: Record<string, ImagePosition>): void {
        super.update(states, vtLayer, imagePositions);
        if (!this.stateDependentLayers.length) return;
        this.lineProgramConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {imagePositions});
        this.fillProgramConfigurations.updatePaintArrays(states, vtLayer, this.stateDependentLayers, {imagePositions});
    }

    isEmpty(): boolean {
        return super.isEmpty() && this.lineLayoutVertexArray.length === 0 && this.fillLayoutVertexArray.length === 0;
    }

    uploadPending(): boolean {
        return super.uploadPending() || this.lineProgramConfigurations.needsUpload || this.fillProgramConfigurations.needsUpload;
    }

    upload(context: Context): void {
        if (!this.uploaded) {
            this.lineLayoutVertexBuffer = context.createVertexBuffer(this.lineLayoutVertexArray, lineLayoutAttributes);
            this.lineIndexBuffer = context.createIndexBuffer(this.lineIndexArray);
            this.fillLayoutVertexBuffer = context.createVertexBuffer(this.fillLayoutVertexArray, fillLayoutAttributes);
            this.fillIndexBuffer = context.createIndexBuffer(this.fillIndexArray);
        }
        this.lineProgramConfigurations.upload(context);
        this.fillProgramConfigurations.upload(context);
        super.upload(context);
    }

    destroy(): void {
        if (this.lineLayoutVertexBuffer) {
            this.lineLayoutVertexBuffer.destroy();
            this.lineIndexBuffer.destroy();
            this.fillLayoutVertexBuffer.destroy();
            this.fillIndexBuffer.destroy();
            this.lineProgramConfigurations.destroy();
            this.fillProgramConfigurations.destroy();
            this.lineSegments.destroy();
            this.fillSegments.destroy();
        }
        super.destroy();
    }
}

register('HeatmapBucket', HeatmapBucket, {omit: ['layers', 'subdivisionGranularity']});
