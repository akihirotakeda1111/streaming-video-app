FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal

ARG TARGETARCH

RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
        amd64) package_arch=x86_64 ;; \
        arm64) package_arch=aarch64 ;; \
        *) echo "Unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/aws-emulator.rpm "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator-${package_arch}.rpm"; \
    rpm -i /tmp/aws-emulator.rpm \
    && rm /tmp/aws-emulator.rpm \
    && mkdir -p /home/emulator/.aws/emulator \
    && chown -R 1000:0 /home/emulator

ENV HOME=/home/emulator
WORKDIR /home/emulator

USER 1000

EXPOSE 9297

ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
