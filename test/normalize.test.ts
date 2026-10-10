import { describe, expect, it } from 'vitest';
import { crossSourceKey, experienceFromText, parseExperienceYears, parseRelativeDate, parseSalary } from '../src/core/normalize.js';

describe('parseSalary', () => {
    it('parses USD yearly ranges', () => {
        expect(parseSalary('$120,000.00/yr - $150,000.00/yr')).toMatchObject({ min: 120000, max: 150000, currency: 'USD', period: 'year' });
    });
    it('parses Indian lakh ranges with a shared unit', () => {
        expect(parseSalary('₹ 5-8 Lacs P.A.')).toMatchObject({ min: 500000, max: 800000, currency: 'INR', period: 'year' });
    });
    it('parses K suffixes and hourly rates', () => {
        expect(parseSalary('€50K - €70K')).toMatchObject({ min: 50000, max: 70000, currency: 'EUR' });
        expect(parseSalary('$40/hr')).toMatchObject({ min: 40, max: 40, period: 'hour' });
    });
    it('keeps raw text when no numbers are present', () => {
        expect(parseSalary('Not disclosed')).toMatchObject({ min: null, max: null, raw: 'Not disclosed' });
        expect(parseSalary('  ')).toBeNull();
    });
});

describe('parseExperienceYears', () => {
    it('handles ranges and open ranges', () => {
        expect(parseExperienceYears('2-5 Yrs')).toEqual({ min: 2, max: 5 });
        expect(parseExperienceYears('3+ years')).toEqual({ min: 3, max: null });
        expect(parseExperienceYears('')).toBeNull();
    });
});

describe('parseRelativeDate', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    it('converts relative dates', () => {
        expect(parseRelativeDate('3 days ago', now)).toBe('2026-10-06T12:00:00.000Z');
        expect(parseRelativeDate('1 week ago', now)).toBe('2026-10-02T12:00:00.000Z');
        expect(parseRelativeDate('30+ days ago', now)).toBe('2026-09-09T12:00:00.000Z');
        expect(parseRelativeDate('Just now', now)).toBe(now.toISOString());
        expect(parseRelativeDate('whenever', now)).toBeNull();
    });
});

describe('crossSourceKey', () => {
    it('matches the same job across sites despite formatting', () => {
        const a = crossSourceKey({ title: 'React Developer', company: 'Acme Pvt. Ltd', location: 'Bengaluru, Karnataka, India' });
        const b = crossSourceKey({ title: 'react developer', company: 'ACME Pvt Ltd', location: 'Bengaluru' });
        expect(a).toBe(b);
    });
});

describe('experienceFromText', () => {
    it('reads ranges and open-ended requirements stated in a description', () => {
        expect(experienceFromText('1 - 2 year experience, immediate joiner')).toEqual({ min: 1, max: 2 });
        expect(experienceFromText('5+ years of React')).toEqual({ min: 5, max: null });
        expect(experienceFromText('Minimum 3 years experience')).toEqual({ min: 3, max: null });
        expect(experienceFromText('2 years of relevant experience')).toEqual({ min: 2, max: null });
    });
    it('ignores numbers that are not about experience', () => {
        // The guard that keeps us from shipping nonsense ranges.
        expect(experienceFromText('Available 2-3 days per week')).toBeNull();
        expect(experienceFromText('Experience with React 18 and Node 22')).toBeNull();
        expect(experienceFromText('Salary 10-15 LPA')).toBeNull();
        expect(experienceFromText('')).toBeNull();
    });
});
