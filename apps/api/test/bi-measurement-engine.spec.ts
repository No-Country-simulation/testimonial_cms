import { measured, ratio, compare, progress, objectiveProgress, metricValues, missing } from '../src/modules/business-intelligence/utils/measurement-engine';
describe('shared BI measurement arithmetic', () => {
  it('preserves exact counts beyond the JS integer limit', () => { expect(measured('9007199254740993')).toEqual({status:'available',value:'9007199254740993',reason:null}); });
  it('keeps unknown separate from zero and permits CTR above 100', () => { expect(ratio(3,2)).toMatchObject({value:'150'}); expect(ratio(0,0)).toEqual(missing('ZERO_DENOMINATOR')); expect(measured(0)).toMatchObject({value:'0'}); });
  it('compares absolute values even with a zero previous value', () => { expect(compare(measured(10),measured(0))).toEqual({absolute:measured(10),relativePercent:missing('ZERO_DENOMINATOR')}); });
  it('propagates missing observations', () => { expect(compare(measured(1),missing('NO_CUT')).absolute).toEqual(missing('NO_CUT')); });
  it.each([['25','0','100','25'], ['15','20','0','25'], ['150','0','100','100'], ['-10','0','100','0']])('calculates directional/clamped progress %s', (actual,base,target,expected) => { expect(progress(measured(actual),base,target).progress).toBe(expected); });
  it('preserves overachievement and rejects equal baselines/targets', () => { expect(progress(measured(150),'0','100').rawProgress).toBe('150'); expect(()=>progress(measured(1),'1','1.00')).toThrow('BI_GOAL_INVALID'); });
  it('does not infer aggregate progress from only known results', () => { expect(objectiveProgress(['100','0'])).toBe('50'); expect(objectiveProgress(['100',null])).toBeNull(); expect(objectiveProgress([])).toBeNull(); });
  it('computes weighted rating and shares from original components', () => {
    const values = metricValues({inventory:{total:'4',draft:'0',pending:'1',approved:'0',published:'2',rejected:'1',ratingSum:'14',lowRating:'1',categorized:'3',tagged:null},engagement:{views:'2',clicks:'3',plays:'0'},creations:null});
    expect(values.average_rating).toEqual(measured('3.5')); expect(values.low_rating_share).toEqual(measured('25')); expect(values.categorized_share).toEqual(measured('75')); expect(values.tagged_share).toEqual(missing('TAGS_NOT_OBSERVED')); expect(values.ctr).toEqual(measured('150'));
  });
  it('retains subtraction precision across the full 28-digit contract', () => { expect(compare(measured('9999999999999999999999999999'),measured('9999999999999999999999999998')).absolute).toEqual(measured('1')); });
  it('bounds numeric output instead of rounding unsafe magnitudes', () => { expect(measured('1e30')).toEqual(missing('OUT_OF_RANGE')); });
});
