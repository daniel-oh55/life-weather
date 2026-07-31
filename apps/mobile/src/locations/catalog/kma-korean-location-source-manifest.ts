/**
 * Provenance record for the KMA Korean administrative-area / forecast-grid source data.
 *
 * Every value here describes the **official** artifact the catalog was generated from — never a
 * download URL, service key, or local filesystem path (see `docs/kma-korean-location-catalog.md`
 * for the update procedure). `sourceSha256` is the SHA-256 of the committed
 * `kma-korean-location-source.tsv` file content (not of the original XLSX, which is not
 * committed), so it is independently reproducible by anyone with this repository.
 */
export interface KmaKoreanLocationSourceManifest {
  readonly provider: 'KMA';
  readonly publicDataDatasetId: '15084084';
  readonly referenceFileName: '기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip';
  readonly sourceModifiedDate: '2026-07-09';
  readonly license: 'KOGL_TYPE_1_ATTRIBUTION';
  readonly normalizedFormat: 'TSV';
  /** Row count of `kma-korean-location-source.tsv` (mechanical extraction, no exclusions). */
  readonly sourceRowCount: number;
  /** SHA-256 hex digest of the committed source TSV file content. */
  readonly sourceSha256: string;
  /**
   * Row count of the generated catalog. Lower than {@link sourceRowCount} because two official
   * source rows (이어도 / Ieodo, codes `5019000000` and `5019099000`) carry the source
   * spreadsheet's `(0, 0)` placeholder coordinate rather than a real Korean lat/lon and are
   * excluded at generation time — no coordinate is invented to keep them.
   */
  readonly generatedRowCount: number;
}

export const kmaKoreanLocationSourceManifest: KmaKoreanLocationSourceManifest = {
  provider: 'KMA',
  publicDataDatasetId: '15084084',
  referenceFileName: '기상청41_단기예보 조회서비스_오픈API활용가이드_2607.zip',
  sourceModifiedDate: '2026-07-09',
  license: 'KOGL_TYPE_1_ATTRIBUTION',
  normalizedFormat: 'TSV',
  sourceRowCount: 3838,
  sourceSha256: '4226dc40fefb54bd6525f590493097851f4724068c2bd90ed67362925fbe48ef',
  generatedRowCount: 3836,
};
