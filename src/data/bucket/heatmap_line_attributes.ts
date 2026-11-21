import {createLayout, type StructArrayLayout, type StructArrayMember} from '../../util/struct_array.ts';

/**
 * The vertex layout of one corner of a line segment's quad in a heatmap.
 *
 * Every corner carries both ends of its segment, so the shader can place the corner around the
 * segment and compute the exact kernel at each fragment. `a_corner` says which corner it is: x is
 * 0 at the segment's start and 1 at its end, y is -1 on one side and 1 on the other.
 */
const layout: StructArrayLayout = createLayout([
    {name: 'a_segment', components: 4, type: 'Int16'},
    {name: 'a_corner', components: 2, type: 'Int16'}
], 4);

export default layout;
export const members: StructArrayMember[] = layout.members;
export const size: number = layout.size;
export const alignment: number = layout.alignment;
