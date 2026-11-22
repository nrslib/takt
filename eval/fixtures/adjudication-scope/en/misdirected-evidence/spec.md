# Listing Service
This change adds paginated record retrieval. page retrieves only the requested range and does not retain every row simultaneously for a page as the row count grows. Row counts continually grow in normal operation.
Preserve the public interface and successful return formats.
