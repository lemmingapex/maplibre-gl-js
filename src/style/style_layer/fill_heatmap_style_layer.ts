import {StyleLayer} from '../style_layer.ts';
import {FillHeatmapBucket} from '../../data/bucket/fill_heatmap_bucket.ts';
import properties, {type FillHeatmapPaintPropsPossiblyEvaluated} from './fill_heatmap_style_layer_properties.g.ts';
import {renderColorRamp} from '../../util/color_ramp.ts';

import type {Transitionable, Transitioning, PossiblyEvaluated} from '../properties.ts';
import type {RGBAImage} from '../../util/image.ts';
import type {Texture} from '../../webgl/texture.ts';
import type {Framebuffer} from '../../webgl/framebuffer.ts';
import type {FillHeatmapPaintProps} from './fill_heatmap_style_layer_properties.g.ts';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';

export const isFillHeatmapStyleLayer = (layer: StyleLayer): layer is FillHeatmapStyleLayer => layer.type === 'fill-heatmap';

/**
 * A style layer that colors the map by how many of its polygons overlap at each point.
 */
export class FillHeatmapStyleLayer extends StyleLayer {

    /** The summed polygon counts, then the same counts blurred horizontally; both at a reduced screen size. */
    heatmapFbos: [Framebuffer | null, Framebuffer | null];
    colorRamp: RGBAImage;
    colorRampTexture: Texture;

    _transitionablePaint: Transitionable<FillHeatmapPaintProps>;
    _transitioningPaint: Transitioning<FillHeatmapPaintProps>;
    paint: PossiblyEvaluated<FillHeatmapPaintProps, FillHeatmapPaintPropsPossiblyEvaluated>;

    createBucket(options: any): FillHeatmapBucket {
        return new FillHeatmapBucket(options);
    }

    constructor(layer: LayerSpecification, globalState: Record<string, any>) {
        super(layer, properties, globalState);

        this.heatmapFbos = [null, null];
        // make sure color ramp texture is generated for default heatmap color too
        this._updateColorRamp();
    }

    _handleSpecialPaintPropertyUpdate(name: string): void {
        if (name === 'fill-heatmap-color') {
            this._updateColorRamp();
        }
    }

    _updateColorRamp(): void {
        const expression = this._transitionablePaint._values['fill-heatmap-color'].value.expression;
        this.colorRamp = renderColorRamp({
            expression,
            evaluationKey: 'heatmapDensity',
            image: this.colorRamp
        });
        this.colorRampTexture = null;
    }

    resize(): void {
        for (const fbo of this.heatmapFbos) {
            fbo?.destroy();
        }
        this.heatmapFbos = [null, null];
    }

    queryRadius(): number {
        return 0;
    }

    queryIntersectsFeature(): boolean {
        return false;
    }

    hasOffscreenPass(): boolean {
        return this.paint.get('fill-heatmap-opacity') !== 0 && !this.isHidden();
    }

    isTileClipped(): boolean {
        return true;
    }
}
