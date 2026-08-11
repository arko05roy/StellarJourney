FROM prom/prometheus:v3.5.0

COPY ops/prometheus/prometheus.yml /etc/prometheus/prometheus.yml
COPY ops/prometheus/alerts.yml /etc/prometheus/alerts.yml

EXPOSE 9090
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=30d", "--web.enable-lifecycle"]
