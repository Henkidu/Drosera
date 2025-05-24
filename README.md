<strong>Problem</strong>

Drosera makes many calls to the RPCs. A single node, especially if free, may not be able to manage the necessary traffic volume.
If you have limited CU or rate for second, the problem at some point becomes evident.


<strong>Solution</strong>

So why not calling more nodes at the same time, and to better distribute the workload?


<strong>What to do</strong>

The only necessary change is to insert the RPC-URL_X links (where X is a progressive number, depending on how many nodes you can call) in the files:

- rpc-proxy.js
- Docker-Compose.yaml

In the Docker-Compose.yaml file you can put the first two nodes of the list, then the script will manage calls by consulting the rpc-proxy.js file.
These scripts must be included in the "Drosera-Network" folder, after installing and configuring according to the official documentation.

<strong>Considerations</strong>

The result will depend on the robustness of the entered RPC: the more CU and RPS you will have available, the better it will be. Don't be surprised then if you see red and gray bars between the green bars. It all depends on the "power" of your RPC nodes.

The scripts can certainly be improved, but the communities gather around the projects for this too!
