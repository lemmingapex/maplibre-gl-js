import {describe, expect, test} from 'vitest';
import Point from '@mapbox/point-geometry';
import {createPopulateOptions} from '../../../test/unit/lib/tile.ts';
import {HeatmapBucket, clipRingToTile, clipSegmentToTile} from './heatmap_bucket.ts';
import {HeatmapStyleLayer} from '../../style/style_layer/heatmap_style_layer.ts';
import {CanonicalTileID} from '../../tile/tile_id.ts';
import {EXTENT} from '../extent.ts';

import type {EvaluationParameters} from '../../style/evaluation_parameters.ts';
import type {ZoomHistory} from '../../style/zoom_history.ts';
import type {BucketParameters, IndexedFeature} from '../bucket.ts';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';

function createHeatmapBucket(geometry: 'vertices' | 'shapes'): HeatmapBucket {
    const layer = new HeatmapStyleLayer({id: 'heatmap', type: 'heatmap', source: 'source', layout: {'heatmap-geometry': geometry}}, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return new HeatmapBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<HeatmapStyleLayer>);
}

/** Returns a feature of the given vector tile geometry type (1 point, 2 line, 3 polygon) in tile units. */
function createFeature(type: 1 | 2 | 3, rings: Array<Array<[number, number]>>): IndexedFeature {
    const feature = {
        type,
        properties: {},
        id: 0,
        extent: EXTENT,
        loadGeometry: () => rings.map(ring => ring.map(([x, y]) => new Point(x, y)))
    } as unknown as VectorTileFeatureLike;
    return {feature, id: 0, index: 0, sourceLayerIndex: 0};
}

function populate(bucket: HeatmapBucket, feature: IndexedFeature) {
    bucket.populate([feature], createPopulateOptions([]), new CanonicalTileID(10, 500, 500));
}

/** Returns the segments the line quads were built from, as `[x0, y0, x1, y1]`, once per quad. */
function lineSegments(bucket: HeatmapBucket): number[][] {
    const segments = [];
    const values = bucket.lineLayoutVertexArray.int16;
    for (let vertex = 0; vertex < bucket.lineLayoutVertexArray.length; vertex += 4) {
        segments.push(Array.from(values.subarray(vertex * 6, vertex * 6 + 4)));
    }
    return segments;
}

describe('clipSegmentToTile', () => {
    test('returns the part of a segment inside the tile', () => {
        const clipped = clipSegmentToTile(new Point(-100, 4096), new Point(EXTENT + 100, 4096));

        expect(clipped).toEqual([new Point(0, 4096), new Point(EXTENT, 4096)]);
    });

    test('returns null for a segment outside the tile', () => {
        expect(clipSegmentToTile(new Point(-200, 10), new Point(-100, 500))).toBeNull();
    });
});

describe('clipRingToTile', () => {
    test('trims a ring larger than the tile to the tile square', () => {
        const ring = [new Point(-100, -100), new Point(EXTENT + 100, -100), new Point(EXTENT + 100, EXTENT + 100), new Point(-100, EXTENT + 100)];

        const clipped = clipRingToTile(ring);

        expect(clipped).toHaveLength(4);
        expect(clipped).toEqual(expect.arrayContaining([new Point(0, 0), new Point(EXTENT, 0), new Point(EXTENT, EXTENT), new Point(0, EXTENT)]));
    });

    test('returns an empty ring for a ring outside the tile', () => {
        expect(clipRingToTile([new Point(-300, 0), new Point(-100, 0), new Point(-100, 200)])).toEqual([]);
    });
});

describe('HeatmapBucket', () => {
    test('draws every vertex of a line as a point with heatmap-geometry: vertices', () => {
        const bucket = createHeatmapBucket('vertices');

        populate(bucket, createFeature(2, [[[100, 100], [200, 100], [200, 200]]]));

        expect(bucket.layoutVertexArray).toHaveLength(3 * 4);
        expect(bucket.lineLayoutVertexArray).toHaveLength(0);
    });

    test('draws one quad per segment of a line with heatmap-geometry: shapes', () => {
        const bucket = createHeatmapBucket('shapes');

        populate(bucket, createFeature(2, [[[100, 100], [200, 100], [200, 200]]]));

        expect(lineSegments(bucket)).toEqual([[100, 100, 200, 100], [200, 100, 200, 200]]);
        expect(bucket.lineIndexArray).toHaveLength(4);
        expect(bucket.layoutVertexArray).toHaveLength(0);
    });

    test('clips a line to the tile, so that the tile beside it draws the rest', () => {
        const bucket = createHeatmapBucket('shapes');

        populate(bucket, createFeature(2, [[[-1000, 100], [300, 100]]]));

        expect(lineSegments(bucket)).toEqual([[0, 100, 300, 100]]);
    });

    test('triangulates the part of a polygon inside the tile with heatmap-geometry: shapes', () => {
        const bucket = createHeatmapBucket('shapes');

        populate(bucket, createFeature(3, [[[-100, -100], [300, -100], [300, 300], [-100, 300], [-100, -100]]]));

        const coordinates = Array.from(bucket.fillLayoutVertexArray.int16);
        expect(bucket.fillIndexArray.length).toBeGreaterThan(0);
        expect(Math.min(...coordinates)).toBe(0);
        expect(Math.max(...coordinates)).toBe(300);
        expect(bucket.layoutVertexArray).toHaveLength(0);
    });

    test('still draws a point as a kernel with heatmap-geometry: shapes', () => {
        const bucket = createHeatmapBucket('shapes');

        populate(bucket, createFeature(1, [[[100, 100]]]));

        expect(bucket.layoutVertexArray).toHaveLength(4);
        expect(bucket.lineLayoutVertexArray).toHaveLength(0);
        expect(bucket.fillLayoutVertexArray).toHaveLength(0);
    });
});
