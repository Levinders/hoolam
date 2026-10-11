-- Home page versions: each version has its own website pictures. The pictures set so far belong to version 1.0.0.
-- Brand images (logo, mark) stay shared by every version. Keys become "<spot>@<version>", e.g. s1-1@1.0.0.
UPDATE media SET slot = slot || '@1.0.0' WHERE slot NOT IN ('logo', 'mark') AND slot NOT LIKE '%@%';
