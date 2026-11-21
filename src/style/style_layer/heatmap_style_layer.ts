import {type QueryIntersectsFeatureParams, StyleLayer} from '../style_layer.ts';
import {HeatmapBucket} from '../../data/bucket/heatmap_bucket.ts';
import properties, {type HeatmapLayoutPropsPossiblyEvaluated, type HeatmapPaintPropsPossiblyEvaluated} from './heatmap_style_layer_properties.g.ts';
import {renderColorRamp} from '../../util/color_ramp.ts';
import {circleIntersection, getMaximumPaintValue} from '../query_utils.ts';
import {polygonIntersectsBufferedMultiLine, polygonIntersectsMultiPolygon} from '../../util/intersection_tests.ts';

import type {Transitionable, Transitioning, Layout, PossiblyEvaluated} from '../properties.ts';
import type {RGBAImage} from '../../util/image.ts';
import type {Texture} from '../../webgl/texture.ts';
import type {Framebuffer} from '../../webgl/framebuffer.ts';
import type {HeatmapLayoutProps, HeatmapPaintProps} from './heatmap_style_layer_properties.g.ts';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {Bucket} from '../../data/bucket.ts';

export const HEATMAP_FULL_RENDER_FBO_KEY = 'big-fb';

export const isHeatmapStyleLayer = (layer: StyleLayer): layer is HeatmapStyleLayer => layer.type === 'heatmap';

/**
 * A style layer that defines a heatmap
 */
export class HeatmapStyleLayer extends StyleLayer {

    heatmapFbos: Map<string, Framebuffer>;
    colorRamp: RGBAImage;
    colorRampTexture: Texture;

    _unevaluatedLayout: Layout<HeatmapLayoutProps>;
    layout: PossiblyEvaluated<HeatmapLayoutProps, HeatmapLayoutPropsPossiblyEvaluated>;

    _transitionablePaint: Transitionable<HeatmapPaintProps>;
    _transitioningPaint: Transitioning<HeatmapPaintProps>;
    paint: PossiblyEvaluated<HeatmapPaintProps, HeatmapPaintPropsPossiblyEvaluated>;

    createBucket(options: any): HeatmapBucket {
        return new HeatmapBucket(options);
    }

    constructor(layer: LayerSpecification, globalState: Record<string, any>) {
        super(layer, properties, globalState);

        this.heatmapFbos = new Map();
        // make sure color ramp texture is generated for default heatmap color too
        this._updateColorRamp();
    }

    _handleSpecialPaintPropertyUpdate(name: string): void {
        if (name === 'heatmap-color') {
            this._updateColorRamp();
        }
    }

    _updateColorRamp(): void {
        const expression = this._transitionablePaint._values['heatmap-color'].value.expression;
        this.colorRamp = renderColorRamp({
            expression,
            evaluationKey: 'heatmapDensity',
            image: this.colorRamp
        });
        this.colorRampTexture = null;
    }

    resize(): void {
        if (this.heatmapFbos.has(HEATMAP_FULL_RENDER_FBO_KEY)) {
            this.heatmapFbos.delete(HEATMAP_FULL_RENDER_FBO_KEY);
        }
    }

    /** Whether lines and polygons are drawn along their length and over their area, rather than at their vertices. */
    drawsShapes(): boolean {
        return this.layout.get('heatmap-geometry') === 'shapes';
    }

    queryRadius(bucket: Bucket): number {
        const heatmapBucket = bucket as HeatmapBucket;
        const pointRadius = getMaximumPaintValue('heatmap-radius', this, heatmapBucket);
        if (!this.drawsShapes() || this.paint.get('heatmap-radius').value.kind === 'constant') return pointRadius;

        return Math.max(pointRadius,
            heatmapBucket.lineProgramConfigurations.get(this.id).getMaxValue('heatmap-radius'),
            heatmapBucket.fillProgramConfigurations.get(this.id).getMaxValue('heatmap-radius'));
    }

    /**
     * With `heatmap-geometry: shapes`, a polygon is hit anywhere inside it and a line anywhere within
     * its radius; points, and every feature with `vertices`, are hit within the radius of a vertex.
     */
    queryIntersectsFeature({
        queryGeometry,
        feature,
        featureState,
        geometry,
        projectedCamera,
        pixelsToTileUnits,
        unwrappedTileID,
        getElevation}: QueryIntersectsFeatureParams
    ): boolean {
        const radius = this.paint.get('heatmap-radius').evaluate(feature, featureState) * pixelsToTileUnits;
        if (this.drawsShapes() && feature.type === 3) return polygonIntersectsMultiPolygon(queryGeometry, geometry);
        if (this.drawsShapes() && feature.type === 2) return polygonIntersectsBufferedMultiLine(queryGeometry, geometry, radius);

        return circleIntersection({
            queryGeometry,
            size: radius,
            projectedCamera,
            unwrappedTileID,
            getElevation
        }, geometry);
    }

    hasOffscreenPass(): boolean {
        return this.paint.get('heatmap-opacity') !== 0 && !this.isHidden();
    }
}
