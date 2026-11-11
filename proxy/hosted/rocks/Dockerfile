# Hosted gRPC-web proxy for the M1 verdict runs. Same Traefik as the benchmark repo's proxy/compose.yml, pinned by digest.
FROM traefik:v3.7.17@sha256:f4bb143d1135a579b630ed491e17ec50f6f7c9c6a30585ff3d385471d2a86f5a
COPY traefik.yml /etc/traefik/traefik.yml
COPY conf/dynamic.yml /etc/traefik/conf/dynamic.yml
