import {describe, test, expect} from 'vitest';
import {HeatmapStyleLayer} from './heatmap_style_layer.ts';
import {type CanonicalTileID, UnwrappedTileID} from '../../tile/tile_id.ts';
import Point from '@mapbox/point-geometry';
import {createTestCamera} from '../../util/test/util.ts';

import type {EvaluationParameters} from '../evaluation_parameters.ts';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';

function createShapesHeatmapLayer(): HeatmapStyleLayer {
    const layer = new HeatmapStyleLayer({
        id: 'heatmap',
        type: 'heatmap',
        layout: {'heatmap-geometry': 'shapes'},
        paint: {'heatmap-radius': 10}
    } as LayerSpecification, {});
    layer.recalculate({} as EvaluationParameters, []);
    return layer;
}

describe('HeatmapStyleLayer.queryIntersectsFeature', () => {
    const feature = {} as VectorTileFeatureLike;
    const featureState = {};
    const geometry = [[new Point(4645, 3729)]];
    const pixelsToTileUnits = 16;
    const unwrappedTileID = new UnwrappedTileID(0, {z: 2, x: 0, y: 1} as CanonicalTileID);
    const getElevation = () => 0;
    const queryGeometryTrue = [new Point(4640, 3725)];
    const queryGeometryFalse = [new Point(6052, 6178)];
    const params = {
        feature,
        featureState,
        geometry,
        pixelsToTileUnits,
        unwrappedTileID,
        getElevation
    };

    function createHeatmapLayer() {
        const heatmapLayer = new HeatmapStyleLayer({
            id: 'heatmap',
            type: 'heatmap',
            paint: {
                'heatmap-radius': 10
            }
        } as LayerSpecification, {});
        heatmapLayer.recalculate({} as EvaluationParameters, []);
        return heatmapLayer;
    }

    test('returns `true` anywhere inside a polygon with heatmap-geometry: shapes', () => {
        const {projectedCamera} = createTestCamera({width: 400, height: 300});
        expect(createShapesHeatmapLayer().queryIntersectsFeature({
            ...params,
            feature: {type: 3} as VectorTileFeatureLike,
            geometry: [[new Point(0, 0), new Point(1000, 0), new Point(1000, 1000), new Point(0, 1000), new Point(0, 0)]],
            queryGeometry: [new Point(500, 500)],
            projectedCamera
        } as any)).toBe(true);
    });

    test('returns `true` within the radius of a line with heatmap-geometry: shapes', () => {
        const {projectedCamera} = createTestCamera({width: 400, height: 300});
        expect(createShapesHeatmapLayer().queryIntersectsFeature({
            ...params,
            feature: {type: 2} as VectorTileFeatureLike,
            geometry: [[new Point(0, 500), new Point(1000, 500)]],
            queryGeometry: [new Point(500, 550)],
            projectedCamera
        } as any)).toBe(true);
    });

    describe('Mercator projection', () => {
        const {projectedCamera} = createTestCamera({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 85, renderWorldCopies: true, width: 400, height: 300});

        test('returns `true` when a heatmap intersects a point', () => {
            expect(createHeatmapLayer().queryIntersectsFeature({
                queryGeometry: queryGeometryTrue,
                projectedCamera,
                ...params
            } as any)).toBe(true);
        });

        test('returns `false` when a heatmap does not intersect a point', () => {
            expect(createHeatmapLayer().queryIntersectsFeature({
                queryGeometry: queryGeometryFalse,
                projectedCamera,
                ...params
            } as any)).toBe(false);
        });
    });

    describe('Globe projection', () => {
        const {projectedCamera} = createTestCamera({width: 400, height: 300}, {projection: 'globe'});

        test('returns `true` when a heatmap intersects a point', () => {
            expect(createHeatmapLayer().queryIntersectsFeature({
                queryGeometry: queryGeometryTrue,
                projectedCamera,
                ...params
            } as any)).toBe(true);
        });

        test('returns `false` when a heatmap does not intersect a point', () => {
            expect(createHeatmapLayer().queryIntersectsFeature({
                queryGeometry: queryGeometryFalse,
                projectedCamera,
                ...params
            } as any)).toBe(false);
        });
    });
});
