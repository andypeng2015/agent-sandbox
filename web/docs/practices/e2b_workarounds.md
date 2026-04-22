---
icon: lucide/wrench
---

# E2B Workarounds

Since E2B SDK need **HTTPS** and **Wildcard Domain** support for sandbox routing, if your environment doesn't support these features, you can use the following workarounds to adapt to your environment.

E2B default sandbox URL format is as follows:  
`https://{port}-{sandboxID}.your-domain.com`   

e.g.  
`https://6080-294bef011f1e4567b4c5d02593e2e90e.example.com`

‼️ If you don't have `https` or Wildcard Domain(*.example.com) support, please config and hack by the following functions `no_wildcard()` to adapt to your environment.

```python
import os

def no_wildcard():
    os.environ['E2B_API_URL'] = 'http://localhost:10000/e2b/v1'
    os.environ['E2B_API_KEY'] = 'testuser-aef134ef-7aa1-945e-9399-7df9a4ad0c3f'
    os.environ['E2B_DOMAIN'] = 'localhost:10000'

    def __connection_config_get_host(_, sandbox_id: str, sandbox_domain: str, port: int) -> str:
        return f"{sandbox_domain}/sandboxes/router/{sandbox_id}/{port}"
    from e2b import ConnectionConfig
    ConnectionConfig.get_host = __connection_config_get_host
```
### No HTTPS
`os.environ['E2B_DEBUG'] = "true"` will use HTTP for API requests, which is useful for local development without HTTPS.

## Kubernetes Ingress Configuration for Wildcard Domain
You can set the following environment variables to configure E2B SDK:

```python
import os
os.environ['E2B_DOMAIN'] = 'example.domain.com'
os.environ['E2B_API_URL'] = 'https://example.domain.com/e2b/v1'
os.environ['E2B_API_KEY'] = 'testuser-aef134ef-7aa1-945e-9399-7df9a4ad0c3f'
```

Agent-Sandbox ingress should also be configured to support wildcard domain.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: agent-sandbox
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: 1024M
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "300"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "300"
spec:
  ingressClassName: ingress-controller
  rules:
    - host: "*.example.domain.com"
      http:
        paths:
          - backend:
              service:
                name: agent-sandbox
                port:
                  number: 80
            path: /
            pathType: ImplementationSpecific
```


## More Information

- [E2B Official Documentation](https://docs.e2b.dev/)
- [e2b-code-interpreter SDK](https://github.com/e2b-dev/e2b-code-interpreter)
- [E2B Desktop SDK](https://github.com/e2b-dev/desktop)