export type SourceName = 'linkedin' | 'naukri' | 'glassdoor';
export type PostedWithin = '24h' | 'week' | 'month' | 'any';
export type WorkType = 'onsite' | 'remote' | 'hybrid';
export type JobType = 'full-time' | 'part-time' | 'contract' | 'temporary' | 'internship';
export type ExperienceLevel = 'internship' | 'entry' | 'associate' | 'mid-senior' | 'director' | 'executive';

export interface Input {
    keywords: string[];
    locations: string[];
    sources: SourceName[];
    maxItemsPerSource: number;
    postedWithin: PostedWithin;
    workType: WorkType[];
    jobType: JobType[];
    experienceLevel: ExperienceLevel[];
    fetchDetails: boolean;
    onlyNewJobs: boolean;
    dedupeAcrossSources: boolean;
    includeDescriptionHtml: boolean;
    proxyConfiguration?: { useApifyProxy?: boolean; apifyProxyGroups?: string[]; apifyProxyCountry?: string; proxyUrls?: string[] };
}

export interface Salary {
    min: number | null;
    max: number | null;
    currency: string | null;
    period: 'hour' | 'day' | 'week' | 'month' | 'year' | null;
    raw: string | null;
}

/**
 * Unified output record. Every key is always present (null when unknown) so that
 * CSV/Excel exports have stable columns across sources.
 */
export interface Job {
    id: string;
    source: SourceName;
    sourceJobId: string;
    url: string;
    applyUrl: string | null;
    title: string;
    company: string | null;
    companyUrl: string | null;
    companyLogo: string | null;
    companyRating: number | null;
    location: string | null;
    workType: WorkType | null;
    jobType: string | null;
    experienceLevel: string | null;
    experienceYears: { min: number | null; max: number | null } | null;
    salary: Salary | null;
    skills: string[];
    postedAt: string | null;
    postedAtRaw: string | null;
    applicants: number | null;
    easyApply: boolean | null;
    /** Company is marked "Actively Hiring" on the listing. */
    activelyHiring: boolean | null;
    /** Listing is marked "Be an early applicant" (few applicants so far). */
    earlyApplicant: boolean | null;
    description: string | null;
    descriptionHtml: string | null;
    industry: string | null;
    jobFunction: string | null;
    detailsFetched: boolean;
    searchKeyword: string;
    searchLocation: string;
    scrapedAt: string;
}

/** One search to run against one source. */
export interface SearchQuery {
    keyword: string;
    location: string;
}
