# Image startup

Mork can publish its runner and egress images with SOCI Index Manifest v2. This
lets compatible Fargate tasks load files as needed during startup. It requires
Linux platform `1.4.0`, private ECR and gzip or uncompressed layers. Lambda keeps
its ordinary single-platform image. [AWS Fargate SOCI requirements](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html).

## Opt in

For a first deployment, use `images:push:soci` in place of `images:push` after ECR
bootstrap. Later deployments use `deploy:soci`:

```sh
mise run images:push:soci
mise run infra:apply
# Later updates:
mise run deploy:soci
```

Run these tasks on Linux with Docker Buildx. They install pinned SOCI `0.16.1`
and crane `0.22.1` through mise. They
export gzip OCI archives with Buildx, convert them through SOCI's standalone
mode, publish the complete image index and verify its v2 artifact before moving
the discovery-only `current` tag. Deployment records the converted digest and
pins it in Terraform. Conversion needs temporary disk space for both layouts.
It does not require a containerd daemon, root access or a Docker socket mounted
in a helper container. [SOCI standalone conversion](https://github.com/awslabs/soci-snapshotter/blob/v0.16.1/docs/cli-usage.md#standalone-mode).

The existing Buildx builder must support OCI exports. If it does not, explicitly
create a separate builder and select it through your local settings:

```sh
mise run soci:builder
MORK_SOCI_BUILDER=mork-soci mise run test:soci
MORK_SOCI_BUILDER=mork-soci mise run deploy:soci
```

`soci:builder` configures a Docker-managed BuildKit builder and leaves the default
builder unchanged. Deployment never creates a builder automatically.
[Docker OCI exporter reference](https://docs.docker.com/build/exporters/oci-docker/).

Normal `deploy` and `images:push` remain available. Running either replaces
`current` with images without SOCI. The v2 manifest digest differs from the
original image while filesystem layers and image configuration stay intact.

## Verification and measurement

```sh
mise run test:soci
```

The local proof builds a fixture, publishes it to a registry bound to localhost,
pulls it back, checks a nonempty SOCI index and verifies unchanged filesystem
layers and configuration. It contacts no AWS account. An OCI archive or layout
can also be published with `mise run soci:publish -- SOURCE IMAGE_REF ALIAS_TAG`.
That command writes the registry named in `IMAGE_REF`.

AWS recommends evaluating lazy loading for images above 250 MiB compressed.
Docker's displayed image size is uncompressed, so measure registry layer sizes
before choosing candidates. The smaller egress image may gain little.
After an authorized AWS deployment, check task metadata's `Snapshotter` value
for `soci`, then compare image-pull and container-start timestamps on equivalent
tasks. Local graph verification establishes packaging, not an AWS startup-time
improvement. [AWS SOCI verification guidance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html).
